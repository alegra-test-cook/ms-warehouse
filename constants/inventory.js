/**
 * Configuración del inventario inicial para el Microservicio de Bodega
 */

// Inventario inicial con el que comienza la bodega
const INITIAL_STOCK = [
  { name: "tomato", stock: 5 },
  { name: "lemon", stock: 5 },
  { name: "potato", stock: 5 },
  { name: "rice", stock: 5 },
  { name: "ketchup", stock: 5 },
  { name: "lettuce", stock: 5 },
  { name: "onion", stock: 5 },
  { name: "cheese", stock: 5 },
  { name: "meat", stock: 5 },
  { name: "chicken", stock: 5 }
];

// Exportar configuraciones
module.exports = {
  INITIAL_STOCK
}; 