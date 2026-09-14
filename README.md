# Poolvault — versão estável

Sistema mobile-first de conta conjunta. A interface da primeira versão foi mantida e o backend foi refeito para não depender de `cookie-parser` e para não falhar quando o Render ainda não estiver com `DATABASE_URL` disponível.

## Armazenamento

- Com `DATABASE_URL`: usa PostgreSQL, recomendado para Render e sincronização entre usuários.
- Sem `DATABASE_URL`: usa um arquivo local `data/poolvault.json`, permitindo testar o sistema imediatamente. Esse modo é apenas para testes locais/temporários.

## Cadastro

Nome completo + 4 últimos dígitos. O servidor cria perfil, conta conjunta, vínculo e sessão em uma única operação. A resposta sempre retorna `ok`, `user`, `profile`, `account` e `session`.

## Comprovantes

Imagens e PDF de até 5 MB. O comprovante fica vinculado ao lançamento e pode ser visualizado pelos membros autenticados da mesma conta.

## Sincronização

Com PostgreSQL e WebSocket, novos lançamentos e novos membros são propagados para os usuários conectados à mesma conta.

## Render

Use o `render.yaml` incluído ou crie um Web Service Node e configure:

- Build: `npm install`
- Start: `npm start`
- `DATABASE_URL`: connection string do PostgreSQL
- `SESSION_SECRET`: uma chave forte

Health check: `/api/health`.

Resultado esperado com PostgreSQL:

`{"ok":true,"db":"postgres","persistent":true}`

## Teste local

1. Instale Node.js 20+.
2. Execute `npm install`.
3. Execute `npm start`.
4. Abra `http://localhost:10000`.

Sem `DATABASE_URL`, o sistema utiliza o armazenamento local para o teste.
