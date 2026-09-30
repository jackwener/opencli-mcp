/** Public element refs are opaque; older connected extensions may still emit unscoped refs. */
export const ELEMENT_REF_SOURCE = String.raw`(?:e[a-f0-9]{16}_\d+|(?:f\d+)?e\d+)`;
export const ELEMENT_REF = new RegExp(`^${ELEMENT_REF_SOURCE}$`);
// Match the ref in a rendered ARIA key, never ref-looking text inside its name or value.
// The renderer may single-quote the whole key; quoted names use JSON escapes.
export const ARIA_REF_LINE = new RegExp(String.raw`^(\s*-\s'?[\w-]+(?: "(?:[^"\\]|\\.)*"| /.*?/)?(?: \[(?!ref=)[^\]\r\n]+\])* \[ref=)(${ELEMENT_REF_SOURCE})(\](?: \[[^\]\r\n]+\])*'?)(:.*)?$`);
