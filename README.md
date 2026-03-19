# Voice Agent Docker — Stack Completa

Stack completa em Docker Compose:
- **drachtio** — servidor SIP (recebe ligações do MicroSIP)
- **agent** — agente de voz (STT→LLM→TTS)
- **sip** — ponte SIP↔WebSocket

## Estrutura

```
voice-agent-docker/
├── docker-compose.yml
├── .env.example
├── prepare.sh              ← copia arquivos do agente
├── drachtio/
│   ├── Dockerfile
│   └── drachtio.conf.xml
├── agent/                  ← preenchido pelo prepare.sh
│   ├── Dockerfile
│   ├── server.js
│   ├── index.html
│   ├── setup-vad.js
│   └── package.json
└── sip/
    ├── Dockerfile
    ├── sip-server.js
    └── package.json
```

## Instalação

### 1. Prepara os arquivos
```bash
chmod +x prepare.sh
./prepare.sh /caminho/para/app-node-chat-voz
```

### 2. Configura o .env
```bash
# Preenche as chaves de API
nano .env

# Descobre seu IP local e coloca no HOST_IP
hostname -I | awk '{print $1}'
```

### 3. Build e start
```bash
docker-compose build
docker-compose up
```

### 4. Verifica se está rodando
```bash
# Status dos containers
docker-compose ps

# Logs em tempo real
docker-compose logs -f

# Health do agente
curl http://localhost:3000/

# Health da ponte SIP
curl http://localhost:3001/health
```

## Configuração do MicroSIP

1. **Adicionar Conta**:
   - Domain: `<seu HOST_IP>` (ex: 192.168.1.100)
   - Username: `1001` (qualquer)
   - Password: `1234` (qualquer)
   - Transport: UDP

2. **Ligar para o agente**:
   ```
   sip:agente@<seu HOST_IP>
   ```

## Por que network_mode: host?

O SIP e RTP têm um problema clássico com NAT/Docker:
- O SIP negocia o IP no corpo do SDP (não no header)
- Com NAT, o container anuncia seu IP interno (172.x.x.x)
- O MicroSIP tenta enviar RTP para esse IP e falha

`network_mode: host` resolve isso — o drachtio e o sip-bridge
veem o IP real da máquina e o anunciam corretamente no SDP.

## Migração para produção (DSIProuter + FreeSWITCH)

```yaml
# Substitua os serviços drachtio e sip por:
services:
  freeswitch:
    image: drachtio/drachtio-freeswitch-mrf:latest
    # mod_audio_stream envia áudio via WebSocket diretamente para o agent
    # O sip-server.js inteiro some — não precisa mais de RTP manual

  agent:
    # Permanece 100% idêntico — só muda quem envia o áudio
```

## Portas utilizadas

| Porta | Protocolo | Serviço |
|-------|-----------|---------|
| 5060 | UDP/TCP | SIP (drachtio) |
| 9022 | TCP | drachtio admin |
| 3000 | TCP | Voice Agent (HTTP/WS) |
| 3001 | TCP | SIP Bridge health |
| 20000-20100 | UDP | RTP media |

### Libera no firewall (se necessário)
```bash
sudo ufw allow 5060/udp
sudo ufw allow 5060/tcp
sudo ufw allow 3000/tcp
sudo ufw allow 20000:20100/udp
```

## Troubleshooting

**MicroSIP registra mas sem áudio:**
- Verifique se `HOST_IP` no `.env` é o IP correto da máquina
- Confirme que portas UDP 20000-20100 estão liberadas no firewall

**drachtio não sobe:**
```bash
docker-compose logs drachtio
# Se erro de compilação, verifique conexão com internet no build
```

**Agente não responde na ligação:**
```bash
docker-compose logs sip
# Verifique se AGENT_WS_URL está correto
curl http://localhost:3001/health
```
