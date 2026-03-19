#!/bin/bash
# prepare.sh
# Copia os arquivos do agente e SIP para as pastas corretas do Docker
# Execute antes do docker-compose up

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "======================================================"
echo "  Preparando contexto Docker"
echo "======================================================"

# ── Agente (voice-agent-v2) ───────────────────────────────────────────────────
AGENT_SRC="${1:-../app-node-chat-voz}"  # passe o caminho como argumento se diferente
AGENT_DST="$SCRIPT_DIR/agent"

echo ""
echo ">>> Copiando arquivos do agente de: $AGENT_SRC"

if [ ! -d "$AGENT_SRC" ]; then
  echo "❌  Diretório não encontrado: $AGENT_SRC"
  echo "   Uso: ./prepare.sh /caminho/para/app-node-chat-voz"
  exit 1
fi

mkdir -p "$AGENT_DST"
cp "$AGENT_SRC/server.js"    "$AGENT_DST/"
cp "$AGENT_SRC/index.html"   "$AGENT_DST/"
cp "$AGENT_SRC/setup-vad.js" "$AGENT_DST/"
cp "$AGENT_SRC/package.json" "$AGENT_DST/"

echo "✓  server.js, index.html, setup-vad.js, package.json"

# ── SIP Bridge ────────────────────────────────────────────────────────────────
echo ""
echo ">>> Arquivos SIP já estão em ./sip/"
ls -la "$SCRIPT_DIR/sip/"

# ── .env ──────────────────────────────────────────────────────────────────────
if [ ! -f "$SCRIPT_DIR/.env" ]; then
  cp "$SCRIPT_DIR/.env.example" "$SCRIPT_DIR/.env"
  echo ""
  echo ">>> .env criado a partir do .env.example"
  echo "⚠️   Edite o .env com suas chaves de API e HOST_IP antes de subir!"
  echo ""
  echo "    Seu IP local:"
  hostname -I | awk '{print "    HOST_IP=" $1}'
fi

echo ""
echo "======================================================"
echo "  Pronto! Próximos passos:"
echo ""
echo "  1. Edite o .env com suas chaves e HOST_IP"
echo "  2. docker-compose build"
echo "  3. docker-compose up"
echo "======================================================"
