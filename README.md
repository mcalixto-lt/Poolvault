# Poolvault 11.0.0

Servidor autocontido, sem dependências externas, mantendo o layout original. Cadastro, sessão, conta conjunta, lançamentos e comprovantes são armazenados no servidor em arquivo JSON. A sincronização entre dispositivos ocorre por atualização automática a cada 4 segundos.

## Local
Node.js 20+ e `npm start`. Acesse `http://localhost:10000`.

## Render
Use o Blueprint `render.yaml`. O serviço utiliza Persistent Disk em `/opt/render/project/src/data` para manter os dados entre reinicializações.
