// Bundle both modules together so tests exercise the same private WeakMap as production.
export { GameFollower, gameFollowConfigSchema, followCommandSchema } from "../../src/main/phones/game-follow";
export { assembleScreenshot } from "../../src/main/phones/screenshot-transfer";
