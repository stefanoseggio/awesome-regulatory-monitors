import { runEngineMain } from '../lib/engine_main.js';
import { TENDERS_USER_AGENT, tendersEngine } from './index.js';

await runEngineMain(tendersEngine, TENDERS_USER_AGENT);
