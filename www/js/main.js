// Application entry point (loaded by index.html): applies the OS light/dark preference and starts the
// shell, which handles routing, the navigation pane and the refresh loop (core/app.js).
import { initTheme } from './core/theme.js';
import { start, watchSession } from './core/app.js';

initTheme();
start();
watchSession();
