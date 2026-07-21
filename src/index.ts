/**
 * Re-export the authoritative plugin composition root from bootstrap.
 * This guarantees package exports have ONE authoritative runtime path.
 */
export { SddPlugin, default } from "./bootstrap/index.js";
