const express = require('express');
const amqp = require('amqplib');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('crypto');

// Importar configuraciones y constantes
const { PORT, RABBIT_URL, MONGO_URL, QUEUE_NAMES } = require('./config');
const { INITIAL_STOCK } = require('./constants/inventory');

const app = express();
app.use(express.json());

async function start() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db('restaurant');
  const ingredientsColl = db.collection('ingredients');
  const purchasesColl = db.collection('purchases');

  if (await ingredientsColl.countDocuments() === 0) {
    await ingredientsColl.insertMany(INITIAL_STOCK);
    console.log("ℹ Inventario inicial insertado en la base de datos de Bodega.");
  }

  const connection = await amqp.connect(RABBIT_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue(QUEUE_NAMES.INGREDIENT_REQUESTS);
  await channel.assertQueue(QUEUE_NAMES.MARKET_REQUESTS); 

  const marketReplyQueue = await channel.assertQueue('', { exclusive: true });
  const marketReplyQueueName = marketReplyQueue.queue;

  const pendingMarketResponses = {};
  channel.consume(marketReplyQueueName, (msg) => {
    if (!msg) return;
    const corrId = msg.properties.correlationId;
    if (corrId && pendingMarketResponses[corrId]) {
      pendingMarketResponses[corrId]();
      delete pendingMarketResponses[corrId];
    }
    channel.ack(msg);
  });

  async function purchaseFromMarket(orderId, ingredientName, quantity) {
    console.log(`👉 Solicitando al mercado ${quantity} unidad(es) de "${ingredientName}" (Pedido ${orderId}).`);
    const corrId = randomUUID();
    const purchasePromise = new Promise(resolve => {
      pendingMarketResponses[corrId] = resolve;
    });
    const purchaseMsg = { orderId: orderId, ingredient: ingredientName, quantity: quantity };
    channel.sendToQueue(QUEUE_NAMES.MARKET_REQUESTS, Buffer.from(JSON.stringify(purchaseMsg)), {
      correlationId: corrId,
      replyTo: marketReplyQueueName
    });
    
    // Esperar confirmación del mercado
    await purchasePromise;
    
    // Registrar la compra en el historial
    await purchasesColl.insertOne({
      ingredient: ingredientName,
      quantity: quantity,
      date: new Date(),
      orderId: orderId
    });
    console.log(`✅ Compra completada: ${quantity} x ${ingredientName} para pedido ${orderId} (historial registrado).`);
  }

  channel.consume(QUEUE_NAMES.INGREDIENT_REQUESTS, async (msg) => {
    if (!msg) return;
    const request = JSON.parse(msg.content.toString());
    const orderId = request.orderId;
    const ingredientsNeeded = request.ingredients;
    console.log(`📦 Bodega recibió solicitud de ingredientes para pedido ${orderId}:`, ingredientsNeeded);

    try {
      // Recopilamos primero lo que tenemos en stock y lo que debemos comprar
      const ingredientPlan = [];
      
      for (const item of ingredientsNeeded) {
        const name = item.name;
        const neededQty = item.quantity;
        const ingredientDoc = await ingredientsColl.findOne({ name: name });
        const currentStock = ingredientDoc ? ingredientDoc.stock : 0;
        
        if (currentStock >= neededQty) {
          // Tenemos suficiente en stock
          ingredientPlan.push({
            name: name,
            fromStock: neededQty,
            toBuy: 0
          });
          console.log(`- Stock de "${name}" suficiente. Se usarán ${neededQty} unidades (stock actual: ${currentStock}).`);
        } else {
          // No hay suficiente, necesitamos comprar
          const fromStock = currentStock;
          const toBuy = neededQty - fromStock;
          ingredientPlan.push({
            name: name,
            fromStock: fromStock,
            toBuy: toBuy
          });
          console.log(`- Stock de "${name}" insuficiente (${currentStock}/${neededQty}). Se usarán ${fromStock} del stock y se comprarán ${toBuy}.`);
        }
      }
      
      // Realizar todas las compras necesarias primero
      for (const item of ingredientPlan) {
        if (item.toBuy > 0) {
          await purchaseFromMarket(orderId, item.name, item.toBuy);
        }
      }
      
      // Una vez que todas las compras están completas, decrementamos el inventario
      for (const item of ingredientPlan) {
        const totalUsed = item.fromStock + item.toBuy;
        await ingredientsColl.updateOne(
          { name: item.name },
          { $inc: { stock: -totalUsed } }
        );
        console.log(`✂ Decrementando ${totalUsed} unidades de "${item.name}" del inventario para pedido ${orderId}.`);
      }
      
      // Enviar confirmación a la cocina
      const responseMsg = { status: 'ready', orderId: orderId };
      channel.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(responseMsg)), {
        correlationId: msg.properties.correlationId
      });
      console.log(`📨 Enviando a Cocina confirmación de ingredientes listos para pedido ${orderId}.`);
    } catch (error) {
      console.error('✘ Error procesando solicitud de ingredientes en Bodega:', error);
    }

    channel.ack(msg);
  });

  app.get('/ingredients', async (_req, res) => {
    try {
      const inventory = await ingredientsColl.find().toArray();
      res.json(inventory);
    } catch (error) {
      res.status(500).send('Error obteniendo inventario');
    }
  });

  app.listen(PORT, () => {
    console.log(`🚀 Servicio de Bodega escuchando en puerto ${PORT}`);
  });
}

start().catch(err => {
  console.error('✘ Error iniciando el Servicio de Bodega:', err);
  process.exit(1);
});