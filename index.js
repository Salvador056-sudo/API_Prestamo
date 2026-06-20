const express = require('express');
const cors = require('cors');
const axios = require('axios');
const pool = require('./db');

const app = express();

app.use(cors());
app.use(express.json());

// ============================================
// FUNCIONES AUXILIARES PARA CONSULTAR APIs
// ============================================

// Obtener información de un libro desde la API de libros
async function obtenerLibro(libroId) {
  try {
    const response = await axios.get(`http://localhost:6005/api/libros/${libroId}`);
    return response.data;
  } catch (err) {
    console.error(`Error al obtener libro ${libroId}:`, err.message);
    return null;
  }
}

// Obtener información de un alumno desde la API de alumnos
async function obtenerAlumno(alumnoId) {
  try {
    const response = await axios.get(`http://localhost:6007/api/alumnos/${alumnoId}`);
    return response.data;
  } catch (err) {
    console.error(`Error al obtener alumno ${alumnoId}:`, err.message);
    return null;
  }
}

// ============================================
// CRUD DE PRÉSTAMOS
// ============================================

// 1. GET - Obtener todos los préstamos (con datos de libro y alumno)
app.get('/api/prestamos', async (req, res) => {
  try {
    const resultado = await pool.query(
      'SELECT * FROM prestamos ORDER BY fecha_prestamo DESC'
    );
    
    const prestamos = resultado.rows;
    
    // Para cada préstamo, obtener datos del libro y alumno
    const prestamosCompletos = await Promise.all(
      prestamos.map(async (prestamo) => {
        const libro = await obtenerLibro(prestamo.libro_id);
        const alumno = await obtenerAlumno(prestamo.alumno_id);
        
        return {
          ...prestamo,
          libro: libro || { id: prestamo.libro_id, titulo: 'Libro no encontrado' },
          alumno: alumno || { id: prestamo.alumno_id, nombre_completo: 'Alumno no encontrado' }
        };
      })
    );
    
    res.json(prestamosCompletos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 2. GET - Préstamos de un alumno específico
app.get('/api/prestamos/alumno/:alumnoId', async (req, res) => {
  try {
    const { alumnoId } = req.params;
    
    // Verificar que el alumno existe
    const alumno = await obtenerAlumno(alumnoId);
    if (!alumno) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }
    
    const resultado = await pool.query(
      'SELECT * FROM prestamos WHERE alumno_id = $1 ORDER BY fecha_prestamo DESC',
      [alumnoId]
    );
    
    const prestamos = resultado.rows;
    
    // Obtener datos de los libros
    const prestamosCompletos = await Promise.all(
      prestamos.map(async (prestamo) => {
        const libro = await obtenerLibro(prestamo.libro_id);
        return {
          ...prestamo,
          libro: libro || { id: prestamo.libro_id, titulo: 'Libro no encontrado' }
        };
      })
    );
    
    res.json(prestamosCompletos);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 3. POST - Crear un préstamo
app.post('/api/prestamos', async (req, res) => {
  try {
    const { libro_id, alumno_id, fecha_devolucion } = req.body;
    
    if (!libro_id || !alumno_id || !fecha_devolucion) {
      return res.status(400).json({ 
        error: 'Libro, alumno y fecha de devolución son requeridos' 
      });
    }
    
    // Verificar que el libro existe y tiene disponibilidad
    const libro = await obtenerLibro(libro_id);
    if (!libro) {
      return res.status(404).json({ error: 'Libro no encontrado' });
    }
    
    if (libro.cantidad_disponible <= 0) {
      return res.status(400).json({ error: 'No hay ejemplares disponibles de este libro' });
    }
    
    // Verificar que el alumno existe
    const alumno = await obtenerAlumno(alumno_id);
    if (!alumno) {
      return res.status(404).json({ error: 'Alumno no encontrado' });
    }
    
    // Crear el préstamo
    const nuevo = await pool.query(
      `INSERT INTO prestamos (libro_id, alumno_id, fecha_prestamo, fecha_devolucion, estado) 
       VALUES ($1, $2, CURRENT_DATE, $3, 'activo') 
       RETURNING *`,
      [libro_id, alumno_id, fecha_devolucion]
    );
    
    // Actualizar la cantidad disponible del libro (vía API)
    await axios.put(`http://localhost:6005/api/libros/${libro_id}`, {
      titulo: libro.titulo,
      autor_id: libro.autor_id,
      isbn: libro.isbn,
      cantidad_disponible: libro.cantidad_disponible - 1
    });
    
    res.status(201).json({
      mensaje: 'Préstamo registrado con éxito',
      prestamo: nuevo.rows[0],
      libro: libro,
      alumno: alumno
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 4. PUT - Registrar devolución de un préstamo
app.put('/api/prestamos/:id/devolver', async (req, res) => {
  try {
    const { id } = req.params;
    
    // Verificar que el préstamo existe y está activo
    const prestamoCheck = await pool.query(
      'SELECT * FROM prestamos WHERE id = $1 AND estado = $2',
      [id, 'activo']
    );
    
    if (prestamoCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Préstamo activo no encontrado' });
    }
    
    const prestamo = prestamoCheck.rows[0];
    
    // Registrar la devolución
    const resultado = await pool.query(
      `UPDATE prestamos 
       SET estado = 'devuelto', fecha_regreso = CURRENT_DATE
       WHERE id = $1 
       RETURNING *`,
      [id]
    );
    
    // Actualizar la cantidad disponible del libro (vía API)
    const libro = await obtenerLibro(prestamo.libro_id);
    if (libro) {
      await axios.put(`http://localhost:6005/api/libros/${prestamo.libro_id}`, {
        titulo: libro.titulo,
        autor_id: libro.autor_id,
        isbn: libro.isbn,
        cantidad_disponible: libro.cantidad_disponible + 1
      });
    }
    
    res.json({
      mensaje: 'Devolución registrada con éxito',
      prestamo: resultado.rows[0]
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 5. DELETE - Eliminar un préstamo (solo si está activo)
app.delete('/api/prestamos/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const resultado = await pool.query(
      'DELETE FROM prestamos WHERE id = $1 AND estado = $2 RETURNING *',
      [id, 'activo']
    );
    
    if (resultado.rows.length === 0) {
      return res.status(404).json({ error: 'Préstamo activo no encontrado' });
    }
    
    // Devolver la cantidad disponible (vía API)
    const prestamo = resultado.rows[0];
    const libro = await obtenerLibro(prestamo.libro_id);
    if (libro) {
      await axios.put(`http://localhost:6005/api/libros/${prestamo.libro_id}`, {
        titulo: libro.titulo,
        autor_id: libro.autor_id,
        isbn: libro.isbn,
        cantidad_disponible: libro.cantidad_disponible + 1
      });
    }
    
    res.json({ mensaje: 'Préstamo eliminado correctamente' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LISTEN
const PORT = process.env.PORT || 6009;
app.listen(PORT, () => {
  console.log(`📋 API Préstamos escuchando en http://localhost:${PORT}`);
  console.log(`   🔗 Integrada con API Libros (http://localhost:6005)`);
  console.log(`   🔗 Integrada con API Alumnos (http://localhost:6007)`);
});
