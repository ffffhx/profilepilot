process.once("message", async (input: { sessionId: string; title: string; directory: string }) => {
  try {
    const sdk: typeof import("@anthropic-ai/claude-agent-sdk") = await (new Function("return import('@anthropic-ai/claude-agent-sdk')")());
    await sdk.renameSession(input.sessionId, input.title, { dir: input.directory });
    process.send?.({ ok: true });
  } catch (error) { process.send?.({ ok: false, error: error instanceof Error ? error.message : String(error) }); }
});
export {};
