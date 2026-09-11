# Poolvault — estrutura completa

Aplicação mobile-first com o layout da primeira versão aprovada, cadastro de perfis, contas conjuntas, PostgreSQL e sincronização por WebSocket.

## Estrutura

Todos os arquivos do frontend ficam na raiz. Não existe pasta `public/`.

- `index.html`
- `styles.css`
- `app.js`
- `server.js`
- `package.json`
- `render.yaml`

## Render

Build: `npm install`

Start: `npm start`

O `render.yaml` cria um Web Service e um PostgreSQL. O servidor usa `DATABASE_URL` como fonte oficial dos dados.

## Cadastro

O primeiro perfil cria automaticamente uma conta conjunta e recebe um código de convite. Outros perfis são independentes e podem entrar na conta pelo menu Membros.

## Sincronização

PostgreSQL é a fonte de verdade. WebSocket transmite alterações de membros e lançamentos para os clientes conectados à mesma conta.

## Diagnóstico

`/api/health` informa se o PostgreSQL está conectado. Em produção, com `DATABASE_URL`, o sistema não usa o fallback em memória.
