import { defineConfig, loadEnv, type Plugin } from "vite";
import { handleRun } from "./server/agent.ts";

/** Mounts the AG-UI endpoint on Vite's own server: one process, one port. */
function agentEndpoint(): Plugin {
  // Braces matter: a returned value would be treated as a post-hook.
  const mount = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use("/agent", handleRun);
  };
  return { name: "ag-ui-agent", configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, { ...loadEnv(mode, process.cwd(), ""), ...process.env });
  return { plugins: [agentEndpoint()], server: { port: 5173 } };
});
