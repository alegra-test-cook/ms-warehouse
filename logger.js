const amqp = require('amqplib');
const { RABBIT_URL } = require('./config');

let channel = null;
const LOG_QUEUE = 'system_logs';

async function initLogger() {
  try {
    if (channel) return;
    
    const connection = await amqp.connect(RABBIT_URL);
    channel = await connection.createChannel();
    await channel.assertQueue(LOG_QUEUE);
    
    console.log('✅ Logger conectado a RabbitMQ');
  } catch (error) {
    console.error('❌ Error conectando el logger a RabbitMQ:', error);
  }
}

async function sendLog(level, message, data = {}) {
  try {
    if (!channel) {
      await initLogger();
    }
    
    const logEntry = {
      timestamp: new Date(),
      service: 'warehouse',
      level,
      message,
      data,
    };
    
    channel.sendToQueue(LOG_QUEUE, Buffer.from(JSON.stringify(logEntry)));
    
    console.log(`[warehouse] [${level}] ${message}`);
    
    return true;
  } catch (error) {
    console.error('❌ Error enviando log:', error);
    return false;
  }
}

const logger = {
  initLogger,
  info: (message, data) => sendLog('info', message, data),
  warning: (message, data) => sendLog('warning', message, data),
  error: (message, data) => sendLog('error', message, data),
  debug: (message, data) => sendLog('debug', message, data)
};

module.exports = logger;