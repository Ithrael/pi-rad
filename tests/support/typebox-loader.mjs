/**
 * Minimal `typebox` / `@earendil-works/pi-ai` stubs for unit tests.
 *
 * Extensions import `Type` from typebox and `StringEnum` from pi-ai at runtime;
 * pi provides the real ones when the extension loads, but plain `node --test`
 * cannot resolve them. The schema values only describe tool parameters, so
 * identity stubs are enough to exercise registration and tool execution.
 */
const STUB_URL =
	"data:text/javascript," +
	encodeURIComponent(
		"const id=(x)=>x;" +
			"export const Type={Object:id,String:id,Number:id,Boolean:id,Optional:id,Array:id,Literal:id,Union:id};",
	);

const PI_AI_STUB_URL =
	"data:text/javascript," + encodeURIComponent("export const StringEnum=(values)=>values;");

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "typebox" || specifier === "@sinclair/typebox" || specifier.startsWith("typebox/")) {
		return { url: STUB_URL, shortCircuit: true };
	}
	if (specifier === "@earendil-works/pi-ai") {
		return { url: PI_AI_STUB_URL, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
