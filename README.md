# spekterm-server

A small server that a team runs for itself so that [spekterm](https://github.com/spekhq/spekterm) users can
hand work to each other. It is a mailbox, a team directory and a presence signal. It runs no agents and has
no access to anyone's repositories.

- What it is and why: [`docs/PRD.md`](docs/PRD.md)
- Running it: [`docs/self-hosting.md`](docs/self-hosting.md)
- The wire protocol spekterm speaks to it: [`docs/protocol.md`](docs/protocol.md)

## Development

Node 22.22 or later. The server is TypeScript run directly by Node (no build step).

```sh
npm install
npm test
npm run typecheck
DATA_DIR=./data PUBLIC_URL=wss://localhost:8080 npm start
DATA_DIR=./data PUBLIC_URL=wss://localhost:8080 npm run admin -- invite create
```

## License

MIT
