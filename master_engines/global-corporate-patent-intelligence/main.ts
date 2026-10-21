import { runEngineMain } from '../lib/engine_main.js';
import { PATENTS_USER_AGENT, patentsEngine } from './index.js';

await runEngineMain(patentsEngine, PATENTS_USER_AGENT);
