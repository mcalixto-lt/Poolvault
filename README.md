# Poolvault

Sistema mobile-first de conta conjunta com PostgreSQL e sincronização em tempo real.

## Estrutura

Todos os arquivos do frontend ficam na raiz. Não existe pasta `public`.

- `index.html`
- `app.js`
- `styles.css`
- `server.js`
- `package.json`
- `render.yaml`
- `manifest.webmanifest`

## Render

O `render.yaml` cria um Web Service Node e um PostgreSQL. O serviço usa:

- Build: `npm install`
- Start: `npm start`
- Health check: `/api/health`

## Cadastro

O usuário informa nome completo e os quatro últimos dígitos do celular. O servidor cria, em uma única transação PostgreSQL:

1. perfil do usuário;
2. conta conjunta;
3. vínculo do usuário à conta;
4. sessão autenticada.

A resposta do cadastro contém `ok`, `user`, `profile`, `account` e `session`.

## Sincronização

PostgreSQL é a fonte central. WebSocket transmite eventos de novos registros e alterações de membros aos usuários conectados à mesma conta conjunta.

## Comprovantes

Imagens e PDFs de até 5 MB são armazenados associados ao lançamento e podem ser visualizados por membros autenticados da mesma conta.

## Teste

Depois do deploy, abra `/api/health`. O resultado esperado é:

`{"ok":true,"db":"postgres","persistent":true}`
