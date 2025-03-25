const express = require('express');
const amqp = require('amqplib');
const { MongoClient } = require('mongodb');
const { randomUUID } = require('crypto');
const cors = require('cors');

const { PORT, RABBIT_URL, MONGO_URL, QUEUE_NAMES } = require('./config');
const { INITIAL_STOCK } = require('./constants/inventory');
const logger = require('./logger');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

async function start() {
  await logger.initLogger();
  await logger.info('🏭 Servicio de Bodega iniciado');
  
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  const db = client.db('restaurant');
  const ingredientsColl = db.collection('ingredients');
  const purchasesColl = db.collection('purchases');

  if (await ingredientsColl.countDocuments() === 0) {
    await ingredientsColl.insertMany(INITIAL_STOCK);
    await logger.info('Inventario inicial insertado en la base de datos de Bodega');
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
    await logger.info(`🛒 🛍️ Solicitando al mercado ${quantity} unidad(es) de "${ingredientName}" (Pedido ${orderId})`);
    
    const corrId = randomUUID();
    const purchasePromise = new Promise(resolve => {
      pendingMarketResponses[corrId] = resolve;
    });
    
    const purchaseMsg = { orderId: orderId, ingredient: ingredientName, quantity: quantity };
    channel.sendToQueue(QUEUE_NAMES.MARKET_REQUESTS, Buffer.from(JSON.stringify(purchaseMsg)), {
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
    
    await logger.info(`🚛 Compra completada: ${quantity} x ${ingredientName} para pedido ${orderId} (historial registrado)`);
  }

  channel.consume(QUEUE_NAMES.INGREDIENT_REQUESTS, async (msg) => {
    if (!msg) return;
    
    const request = JSON.parse(msg.content.toString());
    const orderId = request.orderId;
    const ingredientsNeeded = request.ingredients;
    
    await logger.info(`📦 Bodega recibió solicitud de ingredientes para pedido ${orderId}`, { 
      ingredientsNeeded: ingredientsNeeded.map(i => `${i.quantity} x ${i.name}`).join(', ') 
    });

    try {
      const ingredientPlan = [];
      
      for (const item of ingredientsNeeded) {
        const name = item.name;
        const neededQty = item.quantity;
        const ingredientDoc = await ingredientsColl.findOne({ name: name });
        const currentStock = ingredientDoc ? ingredientDoc.stock : 0;
        
        if (currentStock >= neededQty) {
          ingredientPlan.push({
            name: name,
            fromStock: neededQty,
            toBuy: 0
          });
          await logger.info(`📦 Stock de "${name}" suficiente. Se usarán ${neededQty} unidades (stock actual: ${currentStock})`);
        } else {
          const fromStock = currentStock;
          const toBuy = neededQty - fromStock;
          ingredientPlan.push({
            name: name,
            fromStock: fromStock,
            toBuy: toBuy
          });
          await logger.info(`📦 Stock de "${name}" insuficiente (${currentStock}/${neededQty}). Se usarán ${fromStock} del stock y se comprarán ${toBuy}`);
        }
      }
      
      for (const item of ingredientPlan) {
        if (item.toBuy > 0) {
          await purchaseFromMarket(orderId, item.name, item.toBuy);
        }
      }
      
      for (const item of ingredientPlan) {
        const totalUsed = item.fromStock + item.toBuy;
        await ingredientsColl.updateOne(
          { name: item.name },
          { $inc: { stock: -totalUsed } }
        );
        await logger.info(`📦 Decrementando ${totalUsed} unidades de "${item.name}" del inventario para pedido ${orderId}`);
      }
      
      const responseMsg = { status: 'ready', orderId: orderId };
      channel.sendToQueue(msg.properties.replyTo, Buffer.from(JSON.stringify(responseMsg)), {
        correlationId: msg.properties.correlationId
      });
      
      await logger.info(`🧑‍🍳 Enviando a Cocina confirmación de ingredientes listos para pedido ${orderId}`);
    } catch (error) {
      await logger.error(`Error procesando solicitud de ingredientes en Bodega: ${error.message}`, { 
        stack: error.stack, 
        orderId 
      });
    }

    channel.ack(msg);
  });

  app.get('/ingredients', async (_req, res) => {
    try {
      const inventory = await ingredientsColl.find().toArray();
      res.json(inventory);
    } catch (error) {
      await logger.error(`Error obteniendo inventario: ${error.message}`, { stack: error.stack });
      res.status(500).send('Error obteniendo inventario');
    }
  });

  app.listen(PORT, () => {
    console.log(`Servicio de Bodega escuchando en puerto ${PORT}`);
  });
}

start().catch(async err => {
  try {
    await logger.error(`Error iniciando el Servicio de Bodega: ${err.message}`, { stack: err.stack });
  } catch (logError) {
    console.error('✘ Error iniciando el Servicio de Bodega:', err);
    console.error('Error adicional al intentar registrar el error:', logError);
  }
  process.exit(1);
});