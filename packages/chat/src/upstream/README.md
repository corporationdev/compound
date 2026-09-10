These contract schemas, thread reducer, pending-request parser and date helpers
come from the source maps shipped in the **t3 0.0.40 npm artifact**. That artifact
uses Effect 4.0.0-beta.103; the reference checkout with the same package version
has since changed. Imports in the two client files point at the local contracts,
and `.ts` import suffixes are removed for Compound's TypeScript configuration.
The implementation otherwise remains upstream code, under the adjacent MIT license.

The server itself is installed from the locked npm package by stage-chat.mjs.
Compound starts it with its Electron executable in `ELECTRON_RUN_AS_NODE` mode,
as T3's desktop app does; no standalone Node runtime is bundled.
JavaScript is packaged in `chat-runtime/app.asar`; native dependencies and the
resource monitor remain alongside it. The unused SDK-bundled Claude executables
are excluded because T3 passes the user's installed Claude path to its SDK.
Upgrade the server lock, these sources, and the protocol integration test together.
Do not substitute a floating T3 version or the unrelated reference checkout.
