// Every /api/* request goes to the read-only router in src/api.js.
import { handle } from "../../src/api.js";

export const onRequest = ({ request, env }) => handle(request, env);
