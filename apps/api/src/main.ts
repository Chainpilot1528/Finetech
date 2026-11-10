import { createApp } from './app.js';
import { loadConfig } from './platform/config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.API_PORT, config.API_HOST);
console.log(JSON.stringify({ level: 'info', event: 'api_started', port: config.API_PORT }));
