/**
 * Minimal `typebox` stub for unit tests.
 *
 * rad-goal.ts imports `Type` from typebox at runtime; pi provides the real one
 * when the extension loads, but plain `node --test` cannot resolve it. The
 * schema values only describe tool parameters, so identity stubs are enough to
 * exercise the extension's registration and event handlers.
 */
const STUB_URL =
	"data:text/javascript," +
	encodeURIComponent(
		"const id=(x)=>x;" +
			"export const Type={Object:id,String:id,Number:id,Boolean:id,Optional:id,Array:id,Literal:id,Union:id};",
	);

export async function resolve(specifier, context, nextResolve) {
	if (specifier === "typebox" || specifier === "@sinclair/typebox" || specifier.startsWith("typebox/")) {
		return { url: STUB_URL, shortCircuit: true };
	}
	return nextResolve(specifier, context);
}
