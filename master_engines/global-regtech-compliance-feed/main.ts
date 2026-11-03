import { runEngineMain } from '../lib/engine_main.js';
import { REGTECH_USER_AGENT, regtechEngine } from './index.js';

await runEngineMain(regtechEngine, REGTECH_USER_AGENT);
