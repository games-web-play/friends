const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});

app.use(express.static(path.join(__dirname, "public")));

const COLORES = ["rojo", "azul", "verde", "amarillo"];
const VALORES = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "+2", "⇄", "⊘"];

const salas = new Map();

function crearBaraja() {
  const baraja = [];
  for (const color of COLORES) {
    for (const valor of VALORES) {
      baraja.push({ color, valor });
      if (valor !== "0") baraja.push({ color, valor });
    }
  }
  for (let i = 0; i < 4; i++) {
    baraja.push({ color: "negro", valor: "🌈" });
    baraja.push({ color: "negro", valor: "+4" });
  }
  return baraja.sort(() => Math.random() - 0.5);
}

function robarCarta(partida) {
  if (partida.mazo.length === 0) {
    const tope = partida.descarte.pop();
    partida.mazo = partida.descarte.sort(() => Math.random() - 0.5);
    partida.descarte = [tope];
  }
  return partida.mazo.pop();
}

function esCartaJugable(carta, partida) {
  const tope = partida.descarte[partida.descarte.length - 1];
  if (partida.pozoCastigo > 0) {
    return carta.valor === "+2" || carta.valor === "+4";
  }
  if (carta.color === "negro") return true;
  if (carta.color === partida.colorActual) return true;
  if (carta.valor === tope.valor) return true;
  return false;
}

function generarCodigoSala() {
  let codigo = "";
  do {
    codigo = "UNO-" + Math.floor(1000 + Math.random() * 9000);
  } while (salas.has(codigo));
  return codigo;
}

function emitirEstadoPartida(sala) {
  const p = sala.partida;
  if (!p) return;

  sala.jugadores.forEach((jug) => {
    const rival = sala.jugadores.find((j) => j.id !== jug.id) || {
      id: "espera",
      nombre: "Esperando rival",
      avatar: "⏳",
      esPremium: false
    };
    const manoPropia = p.manos[jug.id] || [];
    const manoRival = p.manos[rival.id] || [];

    io.to(jug.id).emit("estado_uno", {
      miId: jug.id,
      yo: { id: jug.id, nombre: jug.nombre, avatar: jug.avatar, esPremium: Boolean(jug.esPremium) },
      rival: {
        id: rival.id,
        nombre: rival.nombre,
        avatar: rival.avatar,
        esPremium: Boolean(rival.esPremium),
        conteoCartas: manoRival.length
      },
      manoJugador: manoPropia,
      cartaTope: p.descarte[p.descarte.length - 1],
      colorActual: p.colorActual,
      turnoId: p.turnoId,
      pozoCastigo: p.pozoCastigo,
      yaRobo: Boolean(p.yaRoboPorJugador[jug.id]),
      ganadorId: p.ganadorId || null,
      evento: p.ultimoEvento || null
    });
  });
}

function iniciarPartidaEnSala(sala) {
  const mazo = crearBaraja();
  const manos = {};

  sala.jugadores.forEach((j) => {
    manos[j.id] = [];
    for (let i = 0; i < 7; i++) {
      manos[j.id].push(mazo.pop());
    }
  });

  let primera = mazo.pop();
  while (primera.color === "negro" || ["+2", "⇄", "⊘"].includes(primera.valor)) {
    mazo.unshift(primera);
    primera = mazo.pop();
  }

  sala.partida = {
    mazo,
    descarte: [primera],
    manos,
    colorActual: primera.color,
    turnoId: sala.jugadores[0].id,
    pozoCastigo: 0,
    yaRoboPorJugador: {},
    ganadorId: null,
    ultimoEvento: "¡Partida iniciada! Empieza el anfitrión."
  };

  sala.estado = "jugando";
  emitirEstadoPartida(sala);
}

io.on("connection", (socket) => {
  socket.on("crear_sala", ({ nombre, avatar, esPremium }) => {
    const codigo = generarCodigoSala();
    const jugador = {
      id: socket.id,
      nombre: (nombre || "Jugador").slice(0, 22),
      avatar: avatar || "🦊",
      esPremium: Boolean(esPremium),
      esAnfitrion: true
    };
    const sala = {
      codigo,
      estado: "espera",
      jugadores: [jugador],
      partida: null
    };
    salas.set(codigo, sala);
    socket.join(codigo);
    socket.data.codigoSala = codigo;

    socket.emit("sala_unida", sala);
    io.to(codigo).emit("mensaje_chat", {
      sistema: true,
      texto: `${jugador.nombre} creó la sala ${codigo}.`
    });
  });

  socket.on("unirse_sala", ({ codigo, nombre, avatar, esPremium }) => {
    const cod = (codigo || "").trim().toUpperCase();
    const sala = salas.get(cod);
    if (!sala) {
      socket.emit("error_sala", "No existe una sala con ese código.");
      return;
    }
    if (sala.jugadores.length >= 2) {
      socket.emit("error_sala", "La sala ya está llena (máx. 2 jugadores).");
      return;
    }

    const jugador = {
      id: socket.id,
      nombre: (nombre || "Invitado").slice(0, 22),
      avatar: avatar || "🐼",
      esPremium: Boolean(esPremium),
      esAnfitrion: false
    };
    sala.jugadores.push(jugador);
    socket.join(cod);
    socket.data.codigoSala = cod;

    socket.emit("sala_unida", sala);
    io.to(cod).emit("actualizar_jugadores", sala.jugadores);
    io.to(cod).emit("mensaje_chat", {
      sistema: true,
      texto: `${jugador.nombre} se unió a la partida.`
    });
  });

  socket.on("enviar_mensaje", (texto) => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala) return;
    const jug = sala.jugadores.find((j) => j.id === socket.id);
    if (!jug) return;

    io.to(cod).emit("mensaje_chat", {
      sistema: false,
      autor: jug.nombre,
      esPremium: Boolean(jug.esPremium),
      texto: String(texto || "").slice(0, 200)
    });
  });

  socket.on("iniciar_partida", () => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala || sala.jugadores.length < 2) return;
    iniciarPartidaEnSala(sala);
  });

  socket.on("revancha_partida", () => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala || sala.jugadores.length < 2) return;
    iniciarPartidaEnSala(sala);
  });

  socket.on("jugar_carta", ({ indice, colorElegido }) => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala || !sala.partida || sala.partida.ganadorId) return;

    const p = sala.partida;
    if (p.turnoId !== socket.id) return;

    const mano = p.manos[socket.id];
    const carta = mano[indice];
    if (!carta || !esCartaJugable(carta, p)) return;

    mano.splice(indice, 1);
    p.descarte.push(carta);
    p.yaRoboPorJugador[socket.id] = false;

    if (carta.color === "negro") {
      p.colorActual = COLORES.includes(colorElegido) ? colorElegido : "rojo";
    } else {
      p.colorActual = carta.color;
    }

    const jugActual = sala.jugadores.find((j) => j.id === socket.id);
    const otroJugador = sala.jugadores.find((j) => j.id !== socket.id);

    io.to(cod).emit("carta_jugada_animacion", {
      jugadorId: socket.id,
      carta
    });

    if (mano.length === 0) {
      p.ganadorId = socket.id;
      p.ultimoEvento = `¡${jugActual ? jugActual.nombre : "Jugador"} ganó la partida!`;
      emitirEstadoPartida(sala);
      return;
    }

    if (carta.valor === "+2" || carta.valor === "+4") {
      const suma = carta.valor === "+4" ? 4 : 2;
      p.pozoCastigo += suma;
      p.ultimoEvento = `¡${jugActual.nombre} acumuló +${suma}! Pozo: +${p.pozoCastigo}`;
      if (otroJugador) p.turnoId = otroJugador.id;
    } else if (carta.valor === "⊘" || carta.valor === "⇄") {
      p.ultimoEvento = `¡${jugActual.nombre} saltó el turno!`;
      p.turnoId = socket.id;
    } else {
      p.ultimoEvento = `${jugActual.nombre} tiró ${carta.valor}`;
      if (otroJugador) p.turnoId = otroJugador.id;
    }

    emitirEstadoPartida(sala);
  });

  socket.on("accion_mazo", () => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala || !sala.partida || sala.partida.ganadorId) return;

    const p = sala.partida;
    if (p.turnoId !== socket.id) return;

    const mano = p.manos[socket.id];
    const jugActual = sala.jugadores.find((j) => j.id === socket.id);
    const otroJugador = sala.jugadores.find((j) => j.id !== socket.id);

    if (p.pozoCastigo > 0) {
      const cantidad = p.pozoCastigo;
      for (let i = 0; i < cantidad; i++) {
        mano.push(robarCarta(p));
      }
      p.pozoCastigo = 0;
      p.yaRoboPorJugador[socket.id] = false;
      p.ultimoEvento = `${jugActual.nombre} robó +${cantidad} cartas del castigo.`;
      if (otroJugador) p.turnoId = otroJugador.id;
      emitirEstadoPartida(sala);
      return;
    }

    if (!p.yaRoboPorJugador[socket.id]) {
      const robada = robarCarta(p);
      mano.push(robada);
      p.yaRoboPorJugador[socket.id] = true;

      if (!esCartaJugable(robada, p)) {
        p.yaRoboPorJugador[socket.id] = false;
        p.ultimoEvento = `${jugActual.nombre} robó y pasó turno.`;
        if (otroJugador) p.turnoId = otroJugador.id;
      } else {
        p.ultimoEvento = `${jugActual.nombre} robó una carta.`;
      }
      emitirEstadoPartida(sala);
    }
  });

  socket.on("pasar_turno", () => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala || !sala.partida || sala.partida.ganadorId) return;

    const p = sala.partida;
    if (p.turnoId !== socket.id || p.pozoCastigo > 0) return;

    const jugActual = sala.jugadores.find((j) => j.id === socket.id);
    p.yaRoboPorJugador[socket.id] = false;
    const otroJugador = sala.jugadores.find((j) => j.id !== socket.id);
    p.ultimoEvento = `${jugActual.nombre} pasó turno.`;
    if (otroJugador) p.turnoId = otroJugador.id;
    emitirEstadoPartida(sala);
  });

  socket.on("disconnect", () => {
    const cod = socket.data.codigoSala;
    const sala = salas.get(cod);
    if (!sala) return;

    sala.jugadores = sala.jugadores.filter((j) => j.id !== socket.id);
    if (sala.jugadores.length === 0) {
      salas.delete(cod);
    } else {
      sala.jugadores[0].esAnfitrion = true;
      sala.estado = "espera";
      sala.partida = null;
      io.to(cod).emit("actualizar_jugadores", sala.jugadores);
      io.to(cod).emit("volver_a_sala");
      io.to(cod).emit("mensaje_chat", {
        sistema: true,
        texto: "Un jugador se desconectó. Volviendo a la sala..."
      });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Servidor PlayZone UNO activo en puerto " + PORT);
});
