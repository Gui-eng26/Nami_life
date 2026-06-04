# Nami — Agente de Saúde via WhatsApp

Agente de IA que ajuda usuários a aderirem a tratamentos via WhatsApp.
Envia lembretes, registra confirmações e controla estoque de medicamentos.

## Stack
Node.js · Claude API · Supabase · Z-API · Railway

## Setup
```bash
cp .env.example .env  # preencher variáveis
npm install
npm start
```

## Atenção
- Supabase: usar `service_role` key (bypassa RLS)
- Z-API: `ZAPI_CLIENT_TOKEN` obrigatório em toda requisição
- Webhook: `POST /webhook/whatsapp`
