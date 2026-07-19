// ============================================================
// JP JEANS EXPO — server.js
// Node.js + Express + MySQL + Resend + Gemini
// Hostinger: jpintermoda.site/api
// ============================================================

const express    = require('express');
const mysql      = require('mysql2/promise');
const { Resend } = require('resend');
const cors       = require('cors');
const multer     = require('multer');
const path       = require('path');
const fs         = require('fs');
require('dotenv').config();

const app    = express();
const resend = new Resend(process.env.RESEND_API_KEY);
const PORT   = process.env.PORT || 3000;

// ── Middleware ───────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ── Carpeta de uploads ───────────────────────────────────────
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// ── Multer para fotos de productos ──────────────────────────
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename:    (_, file, cb) => {
    const unique = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${unique}${path.extname(file.originalname)}`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB máximo
  fileFilter: (_, file, cb) => {
    const tipos = /jpeg|jpg|png|webp/;
    cb(null, tipos.test(file.mimetype));
  },
});

// ── Pool de MySQL ────────────────────────────────────────────
const pool = mysql.createPool({
  host:     process.env.DB_HOST     || 'localhost',
  user:     process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit:    10,
});

// ── Verificar conexión al iniciar ────────────────────────────
pool.getConnection()
  .then(conn => {
    console.log('✅ MySQL conectado');
    conn.release();
  })
  .catch(err => console.error('❌ Error MySQL:', err.message));

// ============================================================
// AUTH
// ============================================================

// POST /api/auth/login
app.post('/api/auth/login', async (req, res) => {
  try {
    const { usuario, password } = req.body;
    if (!usuario || !password) {
      return res.status(400).json({ exito: false, mensaje: 'Usuario y contraseña requeridos' });
    }

    const [rows] = await pool.query(
      'SELECT id, nombre, usuario, rol FROM staff WHERE usuario = ? AND password = ? AND activo = 1',
      [usuario, password]
    );

    if (rows.length === 0) {
      return res.status(401).json({ exito: false, mensaje: 'Usuario o contraseña incorrectos' });
    }

    res.json({ exito: true, usuario: rows[0] });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ============================================================
// PRODUCTOS
// ============================================================

// GET /api/productos — listar todos
app.get('/api/productos', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, sku, nombre, precio_venta, piezas_por_paquete,
              num_paquetes, tallas, sobrantes, stock_total,
              url_foto, estado_produccion, estado
       FROM productos
       WHERE estado = 'activo'
       ORDER BY fecha_creado DESC`
    );

    // Parsear JSON de tallas y sobrantes
    const productos = rows.map(p => ({
      ...p,
      tallas:    _parseJSON(p.tallas,    []),
      sobrantes: _parseJSON(p.sobrantes, []),
    }));

    res.json({ exito: true, productos });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// GET /api/productos/buscar?q=SKU
app.get('/api/productos/buscar', async (req, res) => {
  try {
    const q = `%${req.query.q || ''}%`;
    const [rows] = await pool.query(
      `SELECT id, sku, nombre, precio_venta, piezas_por_paquete,
              num_paquetes, tallas, sobrantes, stock_total,
              url_foto, estado_produccion
       FROM productos
       WHERE estado = 'activo'
         AND (sku LIKE ? OR nombre LIKE ?)
       LIMIT 10`,
      [q, q]
    );

    const productos = rows.map(p => ({
      ...p,
      tallas:    _parseJSON(p.tallas,    []),
      sobrantes: _parseJSON(p.sobrantes, []),
    }));

    res.json({ exito: true, productos });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// POST /api/productos — registrar con foto
app.post('/api/productos', upload.single('foto'), async (req, res) => {
  try {
    const {
      sku, nombre, precio_venta, num_paquetes,
      piezas_por_paquete, tallas, sobrantes,
      stock_total, estado_produccion,
    } = req.body;

    // Validar SKU único
    const [existe] = await pool.query(
      'SELECT id FROM productos WHERE sku = ?', [sku]
    );
    if (existe.length > 0) {
      return res.status(400).json({ exito: false, mensaje: `El SKU ${sku} ya está registrado` });
    }

    const urlFoto = req.file
      ? `${process.env.BASE_URL || 'https://jpintermoda.site'}/uploads/${req.file.filename}`
      : null;

    const [result] = await pool.query(
      `INSERT INTO productos
         (sku, nombre, precio_venta, piezas_por_paquete, num_paquetes,
          tallas, sobrantes, stock_total, url_foto, estado_produccion)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        sku.toUpperCase(), nombre,
        parseFloat(precio_venta), parseInt(piezas_por_paquete),
        parseInt(num_paquetes), tallas, sobrantes,
        parseInt(stock_total), urlFoto, estado_produccion || 'produccion',
      ]
    );

    // Bitácora
    await _registrarMovimiento({
      tipo:        'REGISTRO_PRODUCTO',
      id_producto: result.insertId,
      descripcion: `Producto registrado: ${sku} — ${nombre}`,
      piezas:      parseInt(stock_total),
    });

    res.json({ exito: true, id: result.insertId, url_foto: urlFoto });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// PUT /api/productos/:id — editar
app.put('/api/productos/:id', async (req, res) => {
  try {
    const {
      nombre, precio_venta, num_paquetes,
      piezas_por_paquete, tallas, sobrantes,
      stock_total, estado_produccion,
    } = req.body;

    await pool.query(
      `UPDATE productos SET
         nombre = ?, precio_venta = ?, num_paquetes = ?,
         piezas_por_paquete = ?, tallas = ?, sobrantes = ?,
         stock_total = ?, estado_produccion = ?
       WHERE id = ?`,
      [
        nombre, parseFloat(precio_venta), parseInt(num_paquetes),
        parseInt(piezas_por_paquete), tallas, sobrantes,
        parseInt(stock_total), estado_produccion, req.params.id,
      ]
    );

    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ============================================================
// PEDIDOS
// ============================================================

// POST /api/pedidos/nuevo
app.post('/api/pedidos/nuevo', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const {
      nombre_cliente, email_cliente, telefono_cliente, direccion_cliente,
      items, subtotal, descuento_porcentaje, descuento_monto,
      total, anticipo, saldo, total_piezas,
    } = req.body;

    // 1. Guardar o buscar cliente
    let idCliente;
    const [clienteExiste] = await conn.query(
      'SELECT id FROM clientes WHERE email = ? LIMIT 1', [email_cliente]
    );
    if (clienteExiste.length > 0) {
      idCliente = clienteExiste[0].id;
    } else {
      const [nuevoCliente] = await conn.query(
        'INSERT INTO clientes (nombre, telefono, email, direccion) VALUES (?, ?, ?, ?)',
        [nombre_cliente, telefono_cliente, email_cliente, direccion_cliente]
      );
      idCliente = nuevoCliente.insertId;
    }

    // 2. Descontar stock por talla
    for (const item of items) {
      const [producto] = await conn.query(
        'SELECT tallas, stock_total FROM productos WHERE id = ? FOR UPDATE',
        [item.id_producto]
      );
      if (producto.length === 0) throw new Error(`Producto ${item.sku} no encontrado`);

      const tallas = _parseJSON(producto[0].tallas, []);
      const tallaIdx = tallas.findIndex(t => t.talla === item.talla);

      if (tallaIdx === -1 || tallas[tallaIdx].cantidad < item.cantidad) {
        throw new Error(`Stock insuficiente: ${item.sku} talla ${item.talla}`);
      }

      tallas[tallaIdx].cantidad -= item.cantidad;
      const nuevoStock = producto[0].stock_total - item.cantidad;

      await conn.query(
        'UPDATE productos SET tallas = ?, stock_total = ? WHERE id = ?',
        [JSON.stringify(tallas), nuevoStock, item.id_producto]
      );
    }

    // 3. Crear el pedido
    const [pedido] = await conn.query(
      `INSERT INTO pedidos
         (id_cliente, nombre_cliente, telefono_cliente, email_cliente,
          direccion_cliente, subtotal, descuento_porcentaje, descuento_monto,
          total, anticipo, saldo, estado, items, total_piezas)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'activo', ?, ?)`,
      [
        idCliente, nombre_cliente, telefono_cliente, email_cliente,
        direccion_cliente, subtotal, descuento_porcentaje || 0,
        descuento_monto || 0, total, anticipo, saldo,
        JSON.stringify(items), total_piezas,
      ]
    );
    const pedidoId = pedido.insertId;

    // 4. Registrar abono inicial
    await conn.query(
      'INSERT INTO abonos (id_pedido, monto, metodo_pago) VALUES (?, ?, ?)',
      [pedidoId, anticipo, 'Efectivo']
    );

    // 5. Bitácora
    await conn.query(
      `INSERT INTO movimientos (tipo, id_pedido, descripcion, monto, piezas, sku_detalle)
       VALUES ('PEDIDO_NUEVO', ?, ?, ?, ?, ?)`,
      [
        pedidoId,
        `Nuevo pedido de ${nombre_cliente}`,
        anticipo, total_piezas,
        JSON.stringify(items.map(i => ({ sku: i.sku, cantidad: i.cantidad, talla: i.talla }))),
      ]
    );

    await conn.commit();

    // 6. Enviar correo de confirmación (async, no bloquea)
    _enviarCorreoPedido({ pedidoId, nombre_cliente, email_cliente,
      items, total, anticipo, saldo, descuento_porcentaje })
      .catch(e => console.error('Error correo pedido:', e));

    res.json({ exito: true, id: pedidoId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ exito: false, mensaje: err.message });
  } finally {
    conn.release();
  }
});

// GET /api/pedidos — listar con filtros
app.get('/api/pedidos', async (req, res) => {
  try {
    const { estado, orden, busqueda } = req.query;

    let query = `
      SELECT id, id_cliente, nombre_cliente, telefono_cliente,
             email_cliente, direccion_cliente, subtotal,
             descuento_porcentaje, descuento_monto, total,
             anticipo, saldo, estado, items, total_piezas,
             correo_enviado, fecha_creado
      FROM pedidos
      WHERE 1=1
    `;
    const params = [];

    if (estado && estado !== 'todos') {
      query += ' AND estado = ?';
      params.push(estado);
    }
    if (busqueda) {
      query += ' AND nombre_cliente LIKE ?';
      params.push(`%${busqueda}%`);
    }

    const ordenMap = {
      'mayor_anticipo': 'anticipo DESC',
      'menor_anticipo': 'anticipo ASC',
      'mas_piezas':     'total_piezas DESC',
      'menos_piezas':   'total_piezas ASC',
    };
    query += ` ORDER BY ${ordenMap[orden] || 'fecha_creado DESC'}`;

    const [rows] = await pool.query(query, params);
    const pedidos = rows.map(p => ({
      ...p,
      items: _parseJSON(p.items, []),
    }));

    res.json({ exito: true, pedidos });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// POST /api/pedidos/liquidar/:id
app.post('/api/pedidos/liquidar/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const [pedidoRows] = await conn.query(
      'SELECT * FROM pedidos WHERE id = ? AND estado = "activo"', [id]
    );
    if (pedidoRows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado o ya liquidado' });
    }
    const pedido = pedidoRows[0];

    // Registrar el pago restante
    if (pedido.saldo > 0) {
      await conn.query(
        'INSERT INTO abonos (id_pedido, monto, metodo_pago) VALUES (?, ?, ?)',
        [id, pedido.saldo, 'Efectivo']
      );
    }

    // Actualizar estado
    await conn.query(
      'UPDATE pedidos SET estado = "liquidado", saldo = 0, anticipo = total WHERE id = ?',
      [id]
    );

    // Bitácora
    await conn.query(
      `INSERT INTO movimientos (tipo, id_pedido, descripcion, monto)
       VALUES ('LIQUIDACION', ?, ?, ?)`,
      [id, `Liquidación pedido #${id} — ${pedido.nombre_cliente}`, pedido.saldo]
    );

    await conn.commit();

    // Correo de liquidación (async)
    _enviarCorreoLiquidacion({
      pedidoId:      id,
      nombre_cliente: pedido.nombre_cliente,
      email_cliente:  pedido.email_cliente,
      total:          pedido.total,
      items:          _parseJSON(pedido.items, []),
    }).catch(e => console.error('Error correo liquidación:', e));

    res.json({ exito: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ exito: false, mensaje: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/pedidos/cancelar/:id
app.post('/api/pedidos/cancelar/:id', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { id } = req.params;

    const [pedidoRows] = await conn.query(
      'SELECT * FROM pedidos WHERE id = ? AND estado = "activo"', [id]
    );
    if (pedidoRows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' });
    }

    const pedido = pedidoRows[0];
    const items  = _parseJSON(pedido.items, []);

    // Devolver stock
    for (const item of items) {
      const [prod] = await conn.query(
        'SELECT tallas, stock_total FROM productos WHERE id = ?', [item.id_producto]
      );
      if (prod.length > 0) {
        const tallas  = _parseJSON(prod[0].tallas, []);
        const tallaIdx = tallas.findIndex(t => t.talla === item.talla);
        if (tallaIdx >= 0) tallas[tallaIdx].cantidad += item.cantidad;
        await conn.query(
          'UPDATE productos SET tallas = ?, stock_total = stock_total + ? WHERE id = ?',
          [JSON.stringify(tallas), item.cantidad, item.id_producto]
        );
      }
    }

    await conn.query(
      'UPDATE pedidos SET estado = "cancelado" WHERE id = ?', [id]
    );

    await conn.query(
      `INSERT INTO movimientos (tipo, id_pedido, descripcion)
       VALUES ('CANCELACION', ?, ?)`,
      [id, `Pedido #${id} cancelado — stock liberado`]
    );

    await conn.commit();
    res.json({ exito: true });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ exito: false, mensaje: err.message });
  } finally {
    conn.release();
  }
});

// POST /api/pedidos/enviado/:id
app.post('/api/pedidos/enviado/:id', async (req, res) => {
  try {
    await pool.query(
      'UPDATE pedidos SET estado = "enviado" WHERE id = ? AND estado = "liquidado"',
      [req.params.id]
    );
    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// POST /api/pedidos/:id/enviar-correo
app.post('/api/pedidos/:id/enviar-correo', async (req, res) => {
  try {
    const { tipo } = req.body;
    const [rows] = await pool.query('SELECT * FROM pedidos WHERE id = ?', [req.params.id]);
    if (rows.length === 0) {
      return res.status(404).json({ exito: false, mensaje: 'Pedido no encontrado' });
    }
    const pedido = rows[0];
    const items  = _parseJSON(pedido.items, []);

    if (tipo === 'confirmacion_pedido') {
      await _enviarCorreoPedido({
        pedidoId:          pedido.id,
        nombre_cliente:    pedido.nombre_cliente,
        email_cliente:     pedido.email_cliente,
        items,
        total:             pedido.total,
        anticipo:          pedido.anticipo,
        saldo:             pedido.saldo,
        descuento_porcentaje: pedido.descuento_porcentaje,
      });
    } else if (tipo === 'liquidacion') {
      await _enviarCorreoLiquidacion({
        pedidoId:      pedido.id,
        nombre_cliente: pedido.nombre_cliente,
        email_cliente:  pedido.email_cliente,
        total:          pedido.total,
        items,
      });
    }

    await pool.query(
      'UPDATE pedidos SET correo_enviado = 1 WHERE id = ?', [req.params.id]
    );

    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ============================================================
// DASHBOARD (Oficina)
// ============================================================

app.get('/api/oficina/dashboard', async (req, res) => {
  try {
    const [[dinero]]  = await pool.query(`
      SELECT
        COALESCE(SUM(CASE WHEN estado = 'liquidado' THEN total ELSE 0 END), 0) AS total_cobrado,
        COALESCE(SUM(CASE WHEN estado = 'activo'    THEN anticipo ELSE 0 END), 0) AS anticipos,
        COALESCE(SUM(CASE WHEN estado = 'activo'    THEN saldo    ELSE 0 END), 0) AS saldo_por_cobrar
      FROM pedidos
    `);

    const [[conteos]] = await pool.query(`
      SELECT
        COUNT(CASE WHEN estado = 'activo'    THEN 1 END) AS pedidos_activos,
        COUNT(CASE WHEN estado = 'liquidado' THEN 1 END) AS pedidos_liquidados,
        COUNT(CASE WHEN estado = 'cancelado' THEN 1 END) AS pedidos_cancelados
      FROM pedidos
    `);

    const [[piezas]] = await pool.query(`
      SELECT
        COALESCE(SUM(stock_total), 0) AS piezas_registradas
      FROM productos WHERE estado = 'activo'
    `);

    const [[vendidas]] = await pool.query(`
      SELECT COALESCE(SUM(total_piezas), 0) AS piezas_vendidas
      FROM pedidos WHERE estado IN ('activo', 'liquidado', 'enviado')
    `);

    const [[skus]] = await pool.query(
      'SELECT COUNT(*) AS total FROM productos WHERE estado = "activo"'
    );

    const piezasRegistradas = piezas.piezas_registradas + vendidas.piezas_vendidas;
    const piezasDisponibles = piezas.piezas_registradas;
    const piezasVendidas    = vendidas.piezas_vendidas;

    res.json({
      exito: true,
      datos: {
        ...dinero,
        ...conteos,
        piezas_registradas: piezasRegistradas,
        piezas_vendidas:    piezasVendidas,
        piezas_disponibles: piezasDisponibles,
        skus_registrados:   skus.total,
        ultima_actualizacion: new Date().toISOString(),
      },
    });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ============================================================
// ANALÍTICA IA
// ============================================================

app.get('/api/analitica/sku', async (req, res) => {
  try {
    // Agrupar piezas vendidas por SKU desde los movimientos
    const [rows] = await pool.query(`
      SELECT
        p.sku,
        p.nombre,
        p.stock_total AS piezas_disponibles,
        COALESCE(SUM(pe.total_piezas), 0) AS piezas_vendidas,
        (p.stock_total + COALESCE(SUM(pe.total_piezas), 0)) AS piezas_total
      FROM productos p
      LEFT JOIN pedidos pe ON JSON_CONTAINS(pe.items, JSON_OBJECT('sku', p.sku))
        AND pe.estado IN ('activo', 'liquidado', 'enviado')
      WHERE p.estado = 'activo'
      GROUP BY p.id, p.sku, p.nombre, p.stock_total
      ORDER BY piezas_vendidas DESC
    `);

    res.json({ exito: true, skus: rows });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});


// GET /api/analitica/prototipos — orden de producción basada en apartados reales
app.get('/api/analitica/prototipos', async (req, res) => {
  try {
    // Obtener todos los prototipos activos
    const [prototipos] = await pool.query(`
      SELECT id, sku, nombre, url_foto, tallas, piezas_por_paquete
      FROM productos
      WHERE estado = 'activo' AND estado_produccion = 'prototipo'
    `);

    const resultado = [];

    for (const proto of prototipos) {
      const tallas = _parseJSON(proto.tallas, []);

      // Buscar pedidos activos/liquidados que contengan este SKU
      const [pedidosItems] = await pool.query(`
        SELECT items FROM pedidos
        WHERE estado IN ('activo', 'liquidado', 'enviado')
          AND JSON_SEARCH(items, 'one', ?, NULL, '$[*].sku') IS NOT NULL
      `, [proto.sku]);

      // Acumular piezas vendidas por talla
      const vendidosPorTalla = {};
      for (const pedido of pedidosItems) {
        const items = _parseJSON(pedido.items, []);
        for (const item of items) {
          if (item.sku === proto.sku) {
            vendidosPorTalla[item.talla] =
              (vendidosPorTalla[item.talla] || 0) + (item.cantidad || 0);
          }
        }
      }

      // Construir array de tallas con piezas vendidas y entallado por paquete
      const tallasVendidas = tallas.map(t => ({
        talla:             t.talla,
        piezas_vendidas:   vendidosPorTalla[t.talla] || 0,
        piezas_por_paquete: t.cantidad,
      }));

      // Solo incluir si tiene al menos un apartado
      const totalVendidas = tallasVendidas.reduce(
        (s, t) => s + t.piezas_vendidas, 0
      );

      if (totalVendidas > 0) {
        resultado.push({
          sku:               proto.sku,
          nombre:            proto.nombre,
          url_foto:          proto.url_foto,
          piezas_por_paquete: proto.piezas_por_paquete,
          tallas_vendidas:   tallasVendidas,
          total_vendidas:    totalVendidas,
        });
      }
    }

    // Ordenar por más vendido
    resultado.sort((a, b) => b.total_vendidas - a.total_vendidas);

    res.json({ exito: true, prototipos: resultado });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// POST /api/analitica/ia — copiloto Gemini
app.post('/api/analitica/ia', async (req, res) => {
  try {
    const { contexto } = req.body;

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: contexto }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 500 },
        }),
      }
    );

    const data = await response.json();
    const texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || 'Sin respuesta';

    res.json({ exito: true, respuesta: texto });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ============================================================
// CORREOS — funciones internas con Resend
// ============================================================

async function _enviarCorreoPedido({
  pedidoId, nombre_cliente, email_cliente,
  items, total, anticipo, saldo, descuento_porcentaje,
}) {
  const itemsHTML = items.map(item => `
    <tr>
      <td style="padding:10px;border-bottom:1px solid #f0f0f0;">
        ${item.url_foto
          ? `<img src="${item.url_foto}" width="50" height="50"
               style="border-radius:6px;object-fit:cover;vertical-align:middle;margin-right:10px;">`
          : ''}
        <strong>${item.sku}</strong> · ${item.nombre}<br>
        <small style="color:#666;">Talla ${item.talla} · ${item.cantidad} pzas · $${item.precio_unitario} c/u</small>
      </td>
      <td style="padding:10px;text-align:right;border-bottom:1px solid #f0f0f0;font-weight:bold;">
        $${(item.cantidad * item.precio_unitario).toLocaleString('es-MX')}
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">

      <div style="text-align:center;margin-bottom:30px;padding-bottom:20px;border-bottom:2px solid #000;">
        <h1 style="margin:0;font-size:28px;letter-spacing:2px;">JP JEANS</h1>
        <p style="margin:4px 0;color:#666;font-size:13px;">INTERMODA · Sta. María Acuitlapilco, Tlaxcala</p>
      </div>

      <h2 style="color:#333;margin-bottom:4px;">¡Tu apartado está confirmado!</h2>
      <p style="color:#666;">Hola <strong>${nombre_cliente}</strong>, aquí está el resumen de tu pedido:</p>
      <p style="color:#999;font-size:12px;">Nota de apartado #${String(pedidoId).padStart(5, '0')} · ${new Date().toLocaleDateString('es-MX', { day:'numeric', month:'long', year:'numeric' })}</p>

      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <thead>
          <tr style="background:#f5f5f5;">
            <th style="padding:10px;text-align:left;font-size:12px;color:#666;text-transform:uppercase;">Producto</th>
            <th style="padding:10px;text-align:right;font-size:12px;color:#666;text-transform:uppercase;">Importe</th>
          </tr>
        </thead>
        <tbody>${itemsHTML}</tbody>
      </table>

      <div style="background:#f9f9f9;border-radius:8px;padding:16px;margin:20px 0;">
        ${descuento_porcentaje > 0 ? `
          <div style="display:flex;justify-content:space-between;margin-bottom:6px;">
            <span style="color:#e74c3c;">Descuento (${descuento_porcentaje}%)</span>
            <span style="color:#e74c3c;">aplicado</span>
          </div>` : ''}
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;font-size:16px;font-weight:bold;">
          <span>Total del pedido</span>
          <span>$${Number(total).toLocaleString('es-MX', {minimumFractionDigits:2})}</span>
        </div>
        <div style="display:flex;justify-content:space-between;margin-bottom:6px;color:#27ae60;">
          <span>Anticipo recibido ✓</span>
          <span>$${Number(anticipo).toLocaleString('es-MX', {minimumFractionDigits:2})}</span>
        </div>
        <div style="display:flex;justify-content:space-between;font-weight:bold;color:#e67e22;border-top:1px solid #eee;padding-top:8px;margin-top:8px;">
          <span>Saldo pendiente</span>
          <span>$${Number(saldo).toLocaleString('es-MX', {minimumFractionDigits:2})}</span>
        </div>
      </div>

      <div style="background:#fff3cd;border-radius:8px;padding:14px;margin:20px 0;border-left:4px solid #ffc107;">
        <p style="margin:0;font-size:13px;color:#856404;">
          <strong>Condiciones:</strong> El anticipo no es reembolsable.
          La mercancía se entrega únicamente al liquidar el saldo total.
        </p>
      </div>

      <div style="text-align:center;margin-top:30px;padding-top:20px;border-top:1px solid #eee;color:#999;font-size:12px;">
        <p>JP Jeans Intermoda · Tel. 246 100 5898</p>
        <p>www.jpjeansvip.com · IG: @jpvipjeans</p>
      </div>
    </body>
    </html>
  `;

  await resend.emails.send({
    from:    process.env.RESEND_FROM || 'JP Jeans <ventas@jpjeansvip.com>',
    to:      email_cliente,
    subject: `✓ Apartado confirmado #${String(pedidoId).padStart(5,'0')} — JP Jeans`,
    html,
  });
}

async function _enviarCorreoLiquidacion({
  pedidoId, nombre_cliente, email_cliente, total, items,
}) {
  const itemsHTML = items.map(item => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #f0f0f0;">
        <strong>${item.sku}</strong> · T${item.talla} · ${item.cantidad} pzas
      </td>
      <td style="padding:8px;text-align:right;border-bottom:1px solid #f0f0f0;">
        $${(item.cantidad * item.precio_unitario).toLocaleString('es-MX')}
      </td>
    </tr>
  `).join('');

  const html = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:20px;color:#333;">

      <div style="text-align:center;margin-bottom:30px;padding-bottom:20px;border-bottom:2px solid #000;">
        <h1 style="margin:0;font-size:28px;letter-spacing:2px;">JP JEANS</h1>
        <p style="margin:4px 0;color:#666;font-size:13px;">INTERMODA · Tlaxcala</p>
      </div>

      <div style="background:#d4edda;border-radius:8px;padding:20px;text-align:center;margin-bottom:24px;">
        <h2 style="color:#155724;margin:0 0 8px;">¡Pedido liquidado! ✓</h2>
        <p style="color:#155724;margin:0;">Gracias <strong>${nombre_cliente}</strong>, tu pago está completo.</p>
      </div>

      <table style="width:100%;border-collapse:collapse;margin:20px 0;">
        <tbody>${itemsHTML}</tbody>
        <tfoot>
          <tr>
            <td style="padding:12px;font-weight:bold;font-size:16px;">TOTAL PAGADO</td>
            <td style="padding:12px;text-align:right;font-weight:bold;font-size:16px;color:#27ae60;">
              $${Number(total).toLocaleString('es-MX', {minimumFractionDigits:2})}
            </td>
          </tr>
        </tfoot>
      </table>

      <div style="text-align:center;margin-top:30px;padding-top:20px;border-top:1px solid #eee;color:#999;font-size:12px;">
        <p>JP Jeans Intermoda · Tel. 246 100 5898</p>
        <p>www.jpjeansvip.com · IG: @jpvipjeans</p>
      </div>
    </body>
    </html>
  `;

  await resend.emails.send({
    from:    process.env.RESEND_FROM || 'JP Jeans <ventas@jpjeansvip.com>',
    to:      email_cliente,
    subject: `✓ Pedido liquidado #${String(pedidoId).padStart(5,'0')} — JP Jeans`,
    html,
  });
}

// ============================================================
// HELPERS
// ============================================================

function _parseJSON(valor, fallback) {
  if (!valor) return fallback;
  try { return typeof valor === 'string' ? JSON.parse(valor) : valor; }
  catch { return fallback; }
}

async function _registrarMovimiento({ tipo, id_pedido, id_producto, descripcion, monto, piezas, sku_detalle }) {
  try {
    await pool.query(
      `INSERT INTO movimientos (tipo, id_pedido, id_producto, descripcion, monto, piezas, sku_detalle)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [tipo, id_pedido || null, id_producto || null, descripcion,
       monto || 0, piezas || 0, sku_detalle ? JSON.stringify(sku_detalle) : null]
    );
  } catch (e) {
    console.error('Error bitácora:', e.message);
  }
}


// PUT /api/productos/:id/eliminar — soft delete (marca como eliminado)
app.put('/api/productos/:id/eliminar', async (req, res) => {
  try {
    const [resultado] = await pool.query(
      "UPDATE productos SET estado = 'eliminado' WHERE id = ? AND estado = 'activo'",
      [req.params.id]
    );

    if (resultado.affectedRows === 0) {
      return res.status(404).json({
        exito: false,
        mensaje: 'Producto no encontrado o ya eliminado',
      });
    }

    await _registrarMovimiento({
      tipo:        'REGISTRO_PRODUCTO',
      id_producto: parseInt(req.params.id),
      descripcion: `Producto #${req.params.id} eliminado del inventario`,
    });

    res.json({ exito: true });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// GET /api/analitica/prototipos — orden de producción basada en apartados reales
app.get('/api/analitica/prototipos', async (req, res) => {
  try {
    const [prototipos] = await pool.query(`
      SELECT id, sku, nombre, url_foto, tallas, piezas_por_paquete
      FROM productos
      WHERE estado = 'activo' AND estado_produccion = 'prototipo'
    `);

    const resultado = [];

    for (const proto of prototipos) {
      const tallas = _parseJSON(proto.tallas, []);

      const [pedidosItems] = await pool.query(`
        SELECT items FROM pedidos
        WHERE estado IN ('activo', 'liquidado', 'enviado')
          AND JSON_SEARCH(items, 'one', ?, NULL, '$[*].sku') IS NOT NULL
      `, [proto.sku]);

      const vendidosPorTalla = {};
      for (const pedido of pedidosItems) {
        const items = _parseJSON(pedido.items, []);
        for (const item of items) {
          if (item.sku === proto.sku) {
            vendidosPorTalla[item.talla] =
              (vendidosPorTalla[item.talla] || 0) + (item.cantidad || 0);
          }
        }
      }

      const tallasVendidas = tallas.map(t => ({
        talla:              t.talla,
        piezas_vendidas:    vendidosPorTalla[t.talla] || 0,
        piezas_por_paquete: t.cantidad,
      }));

      const totalVendidas = tallasVendidas.reduce(
        (s, t) => s + t.piezas_vendidas, 0
      );

      if (totalVendidas > 0) {
        resultado.push({
          sku:                proto.sku,
          nombre:             proto.nombre,
          url_foto:           proto.url_foto,
          piezas_por_paquete: proto.piezas_por_paquete,
          tallas_vendidas:    tallasVendidas,
          total_vendidas:     totalVendidas,
        });
      }
    }

    resultado.sort((a, b) => b.total_vendidas - a.total_vendidas);
    res.json({ exito: true, prototipos: resultado });
  } catch (err) {
    res.status(500).json({ exito: false, mensaje: err.message });
  }
});

// ── Health check ─────────────────────────────────────────────
app.get('/api/ping', (_, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── Arrancar servidor ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 JP Jeans server corriendo en puerto ${PORT}`);
});