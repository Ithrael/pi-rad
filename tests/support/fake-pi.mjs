/**
 * Minimal fake ExtensionAPI + context for unit-testing extensions without pi.
 *
 * Records registrations and lets tests invoke handlers/tools/commands directly.
 */

export function makePi(initialTools = ["read", "bash", "edit", "write", "grep", "find", "ls"]) {
	const handlers = new Map();
	const tools = new Map();
	const commands = new Map();
	const shortcuts = new Map();
	const entries = [];
	const messages = [];
	let activeTools = [...initialTools];

	const pi = {
		on: (event, handler) => handlers.set(event, handler),
		registerTool: (tool) => tools.set(tool.name, tool),
		registerCommand: (name, options) => commands.set(name, options),
		registerShortcut: (key, options) => shortcuts.set(key, options),
		sendMessage: (message) => messages.push(message),
		sendUserMessage: (message) => messages.push(message),
		appendEntry: (customType, data) => entries.push({ customType, data }),
		getAllTools: () => activeTools.map((name) => ({ name, sourceInfo: { source: "builtin" } })),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names) => {
			activeTools = [...names];
		},
	};

	return {
		pi,
		handlers,
		tools,
		commands,
		shortcuts,
		entries,
		messages,
		activeTools: () => [...activeTools],
	};
}

export function makeCtx(mode = "tui") {
	const statuses = new Map();
	const notifications = [];
	const ctx = {
		mode,
		hasUI: true,
		cwd: process.cwd(),
		ui: {
			setStatus: (key, value) => statuses.set(key, value),
			notify: (message) => notifications.push(message),
			select: async () => null,
			confirm: async () => true,
			getTheme: () => undefined,
			setTheme: () => {},
		},
		sessionManager: { getEntries: () => [] },
		isIdle: () => true,
		hasPendingMessages: () => false,
	};
	return { ctx, statuses, notifications };
}
