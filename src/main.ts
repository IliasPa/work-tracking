import './style.css';
import { registerSW } from 'virtual:pwa-register';

registerSW({ immediate: true });

const root = document.getElementById('app')!;
const env = import.meta.env;

if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_PROJECT_ID) {
  root.innerHTML = `
    <main class="center">
      <div class="signin">
        <h1>Firebase not configured</h1>
        <p class="muted">Copy <code>.env.example</code> to <code>.env</code>, fill in your Firebase web app
        config, then restart the dev server. See the README for the full setup.</p>
      </div>
    </main>`;
} else {
  import('./app').then((m) => m.start(root));
}
