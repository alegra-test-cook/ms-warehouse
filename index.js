const express = require('express');
const amqp = require('amqplib');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('crypto');

const PORT = process.env.PORT || 3003;
const RABBIT_URL = process.env.RABBITMQ_URL || 'amqp://localhost';
const MONGO_URL = process.env.MONGO_URL || 'mongodb+srv://heanfig:UBP3AqbGlPWEpdDn@alegra-test.kbne8.mongodb.net/?retryWrites=true&w=majority&appName=alegra-test';

const app = express();
app.use(express.json());

async function start() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db('restaurant');
  const ingredientsColl = db.collection('ingredients');
  const purchasesColl = db.collection('purchases');

  if (await ingredientsColl.countDocuments() === 0) {
    const initialStock = [
      { name: "pasta", stock: 5 },
      { name: "salsa de tomate", stock: 10 },
      { name: "carne molida", stock: 5 },
      { name: "lechuga", stock: 5 },
      { name: "crutones", stock: 5 },
      { name: "queso parmesano", stock: 5 },
      { name: "pollo", stock: 3 },
      { name: "masa", stock: 5 },
      { name: "queso mozzarella", stock: 5 },
      { name: "albahaca", stock: 5 }
    ];
    await ingredientsColl.insertMany(initialStock);
    console.log("ℹ Inventario inicial insertado en la base de datos de Bodega.");
  }

  const connection = await amqp.connect(RABBIT_URL);
  const channel = await connection.createChannel();

  await channel.assertQueue('ingredient_requests');
  await channel.assertQueue('market_requests'); 

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
    channel.sendToQueue('market_requests', Buffer.from(JSON.stringify(purchaseMsg)), {
      correlationId: corrId,
      replyTo: marketReplyQueueName
    });
    await purchasePromise;
    await purchasesColl.insertOne({
      ingredient: ingredientName,
      quantity: quantity,
      date: new Date(),
      orderId: orderId
    });
    console.log(`✅ Compra completada: ${quantity} x ${ingredientName} para pedido ${orderId} (historial registrado).`);
  }

  channel.consume('ingredient_requests', async (msg) => {
    if (!msg) return;
    const request = JSON.parse(msg.content.toString());
    const orderId = request.orderId;
    const ingredientsNeeded = request.ingredients;
    console.log(`📦 Bodega recibió solicitud de ingredientes para pedido ${orderId}:`, ingredientsNeeded);

    try {
      for (const item of ingredientsNeeded) {
        const name = item.name;
        const neededQty = item.quantity;
        const ingredientDoc = await ingredientsColl.findOne({ name: name });
        const currentStock = ingredientDoc ? ingredientDoc.stock : 0;
        if (currentStock >= neededQty) {
          await ingredientsColl.updateOne(
            { name: name },
            { $inc: { stock: -neededQty } }
          );
          console.log(`- Stock de "${name}" suficiente. Usando ${neededQty} del inventario (queda ${currentStock - neededQty}).`);
        } else {
          console.log(`- Stock de "${name}" insuficiente (${currentStock}/${neededQty}).`);
          let usedFromStock = 0;
          if (currentStock > 0) {
            usedFromStock = currentStock;
            await ingredientsColl.updateOne({ name: name }, { $set: { stock: 0 } });
            console.log(`  Usando ${usedFromStock} de "${name}" del inventario (stock queda 0, faltan ${neededQty - usedFromStock}).`);
          }
          const lackingQty = neededQty - usedFromStock;
          await purchaseFromMarket(orderId, name, lackingQty);
          console.log(`  Ingrediente "${name}" ahora disponible. Cantidad ${neededQty} obtenida (incluyendo compra). Stock actual: 0.`);
        }
      }
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