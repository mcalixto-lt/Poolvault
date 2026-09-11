# Poolvault — sistema completo

Base visual preservada da primeira versão enviada, com cadastro, login, conta conjunta, registros, comprovantes, extrato, membros e sincronização em tempo real.

## Local
1. Instale Node.js 20+.
2. Rode `npm install`.
3. Rode `npm start`.
4. Abra `http://localhost:10000`.

Sem `DATABASE_URL`, o sistema usa banco em memória apenas para teste local. Para produção use PostgreSQL.

## Render
Suba o projeto no GitHub e crie um Web Service usando `render.yaml`, ou configure manualmente:
- Build: `npm install`
- Start: `npm start`
- PostgreSQL: variável `DATABASE_URL`
- `JWT_SECRET`: segredo gerado

## Conta conjunta
O primeiro perfil cria automaticamente uma conta conjunta. Em **Membros**, copie o código de convite. Um novo usuário pode informar esse código durante o cadastro para entrar na mesma conta.

## Sincronização
Todos os lançamentos são gravados no PostgreSQL. O servidor transmite eventos por WebSocket para os usuários autenticados da mesma conta, atualizando saldo, extrato e membros automaticamente.
