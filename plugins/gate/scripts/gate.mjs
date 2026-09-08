#!/usr/bin/env node
var __defProp = Object.defineProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// src/client/cli.ts
import { mkdirSync as mkdirSync8, readFileSync as readFileSync6, writeFileSync as writeFileSync6 } from "node:fs";
import { homedir as homedir6 } from "node:os";
import { basename, join as join9, resolve as resolve6 } from "node:path";
import { createInterface } from "node:readline/promises";

// src/agents/registry.ts
import { existsSync as existsSync3, mkdirSync as mkdirSync3, readFileSync as readFileSync2, readdirSync as readdirSync2, rmSync, statSync as statSync2, writeFileSync as writeFileSync2 } from "node:fs";
import { join as join4 } from "node:path";

// src/lib/def-root.ts
import { existsSync, mkdirSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
var DEFAULT_TEAM = "default";
function gateHome() {
  return process.env.GATE_HOME || join(homedir(), ".gate");
}
function teamScope(teamId = DEFAULT_TEAM) {
  migrateLegacyDefinitions();
  const root = join(gateHome(), "teams", teamId);
  if (teamId === DEFAULT_TEAM) return { root, teamId };
  return { root, teamId, fallback: { root: join(gateHome(), "teams", DEFAULT_TEAM), teamId: DEFAULT_TEAM } };
}
function scopeAt(root, teamId) {
  return { root, teamId };
}
var g = globalThis;
function migrateLegacyDefinitions() {
  const home = gateHome();
  if (g.__gateDefinitionsMigrated === home) return;
  g.__gateDefinitionsMigrated = home;
  const target = join(home, "teams", DEFAULT_TEAM);
  for (const kind of ["agents", "workflows"]) {
    const legacy = join(home, kind);
    const next = join(target, kind);
    if (!existsSync(legacy) || existsSync(next)) continue;
    try {
      mkdirSync(target, { recursive: true, mode: 448 });
      renameSync(legacy, next);
    } catch {
    }
  }
}

// node_modules/js-yaml/dist/js-yaml.mjs
var NOT_RESOLVED = /* @__PURE__ */ Symbol("NOT_RESOLVED");
function defineScalarTag(tagName, options) {
  return {
    tagName,
    nodeKind: "scalar",
    implicit: options.implicit ?? false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    implicitFirstChars: options.implicitFirstChars ?? null,
    resolve: options.resolve,
    identify: options.identify,
    represent: options.represent ?? ((data) => String(data)),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineSequenceTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "sequence",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addItem: options.addItem,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
function defineMappingTag(tagName, options) {
  const carrierIsResult = options.finalize === void 0;
  return {
    tagName,
    nodeKind: "mapping",
    implicit: false,
    matchByTagPrefix: options.matchByTagPrefix ?? false,
    create: options.create,
    addPair: options.addPair,
    has: options.has,
    keys: options.keys,
    get: options.get,
    finalize: options.finalize ?? ((carrier) => carrier),
    carrierIsResult,
    identify: options.identify,
    represent: options.represent ?? ((data) => data),
    representTagName: options.representTagName ?? (() => tagName)
  };
}
var strTag = defineScalarTag("tag:yaml.org,2002:str", {
  resolve: (source) => source,
  identify: (data) => typeof data === "string"
});
var NULL_VALUES$1 = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullCoreTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES$1.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var nullJsonTag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: ["n"],
  resolve: (source, isExplicit) => {
    if (source === "null" || isExplicit && source === "") return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var NULL_VALUES = [
  "",
  "~",
  "null",
  "Null",
  "NULL"
];
var nullYaml11Tag = defineScalarTag("tag:yaml.org,2002:null", {
  implicit: true,
  implicitFirstChars: [
    "",
    "~",
    "n",
    "N"
  ],
  resolve: (source) => {
    if (NULL_VALUES.indexOf(source) !== -1) return null;
    return NOT_RESOLVED;
  },
  identify: (object) => object === null,
  represent: () => "null"
});
var TRUE_VALUES$2 = [
  "true",
  "True",
  "TRUE"
];
var FALSE_VALUES$2 = [
  "false",
  "False",
  "FALSE"
];
var boolCoreTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "t",
    "T",
    "f",
    "F"
  ],
  resolve: (source) => {
    if (TRUE_VALUES$2.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$2.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES$1 = ["true"];
var FALSE_VALUES$1 = ["false"];
var boolJsonTag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: ["t", "f"],
  resolve: (source) => {
    if (TRUE_VALUES$1.indexOf(source) !== -1) return true;
    if (FALSE_VALUES$1.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var TRUE_VALUES = [
  "true",
  "True",
  "TRUE",
  "y",
  "Y",
  "yes",
  "Yes",
  "YES",
  "on",
  "On",
  "ON"
];
var FALSE_VALUES = [
  "false",
  "False",
  "FALSE",
  "n",
  "N",
  "no",
  "No",
  "NO",
  "off",
  "Off",
  "OFF"
];
var boolYaml11Tag = defineScalarTag("tag:yaml.org,2002:bool", {
  implicit: true,
  implicitFirstChars: [
    "y",
    "Y",
    "n",
    "N",
    "t",
    "T",
    "f",
    "F",
    "o",
    "O"
  ],
  resolve: (source) => {
    if (TRUE_VALUES.indexOf(source) !== -1) return true;
    if (FALSE_VALUES.indexOf(source) !== -1) return false;
    return NOT_RESOLVED;
  },
  identify: (object) => Object.prototype.toString.call(object) === "[object Boolean]",
  represent: (object) => object ? "true" : "false"
});
var YAML_INTEGER_IMPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:0o[0-7]+|0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
var YAML_INTEGER_EXPLICIT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$2(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$2(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN$1.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$2(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intCoreTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger$2,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)$");
var YAML_INTEGER_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1]+|[-+]?0o[0-7]+|[-+]?0x[0-9a-fA-F]+|[-+]?[0-9]+)$");
function parseYamlInteger$1(source) {
  let value = source;
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0o")) return sign * parseInt(value.slice(2), 8);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_INTEGER_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  } else if (!YAML_INTEGER_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger$1(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intJsonTag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlInteger$1,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_INTEGER_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?0x[0-9a-fA-F_]+|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+|[-+]?(?:0|[1-9][0-9_]*))$");
function parseYamlInteger(source) {
  let value = source.replace(/_/g, "");
  let sign = 1;
  if (value[0] === "-" || value[0] === "+") {
    if (value[0] === "-") sign = -1;
    value = value.slice(1);
  }
  if (value.startsWith("0b")) return sign * parseInt(value.slice(2), 2);
  if (value.startsWith("0x")) return sign * parseInt(value.slice(2), 16);
  if (value.includes(":")) {
    let result = 0;
    for (const part of value.split(":")) result = result * 60 + Number(part);
    return sign * result;
  }
  if (value !== "0" && value[0] === "0") return sign * parseInt(value, 8);
  return sign * parseInt(value, 10);
}
function resolveYamlInteger(source) {
  if (!YAML_INTEGER_PATTERN.test(source)) return NOT_RESOLVED;
  const result = parseYamlInteger(source);
  return Number.isFinite(result) ? result : NOT_RESOLVED;
}
var intYaml11Tag = defineScalarTag("tag:yaml.org,2002:int", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ..."0123456789"
  ],
  resolve: resolveYamlInteger,
  identify: (object) => Number.isInteger(object) && !Object.is(object, -0) && object.toString(10).indexOf("e") < 0,
  represent: (object) => object.toString(10)
});
var YAML_FLOAT_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN$1 = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$2(source) {
  if (!YAML_FLOAT_PATTERN$1.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase();
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  const result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN$1.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$2(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatCoreTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat$2,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$2
});
var YAML_FLOAT_IMPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^-?(?:0|[1-9][0-9]*)(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?$");
var YAML_FLOAT_EXPLICIT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?[0-9]+(?:\\.[0-9]*)?(?:[eE][-+]?[0-9]+)?|[-+]?\\.[0-9]+(?:[eE][-+]?[0-9]+)?|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat$1(source, isExplicit) {
  if (isExplicit) {
    if (!YAML_FLOAT_EXPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
    let value = source.toLowerCase();
    const sign = value[0] === "-" ? -1 : 1;
    if ("+-".includes(value[0])) value = value.slice(1);
    if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
    if (value === ".nan") return NaN;
    const result2 = sign * parseFloat(value);
    return Number.isFinite(result2) ? result2 : NOT_RESOLVED;
  }
  if (!YAML_FLOAT_IMPLICIT_PATTERN.test(source)) return NOT_RESOLVED;
  const result = Number(source);
  if (Number.isFinite(result)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat$1(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatJsonTag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: ["-", ..."0123456789"],
  resolve: resolveYamlFloat$1,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat$1
});
var YAML_FLOAT_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?(?:(?:[0-9][0-9_]*)?\\.[0-9_]*)(?:[eE][-+][0-9]+)?|[-+]?[0-9][0-9_]*(?::[0-5]?[0-9])+\\.[0-9_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
var YAML_FLOAT_SPECIAL_PATTERN = /* @__PURE__ */ new RegExp("^(?:[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN))$");
function resolveYamlFloat(source) {
  if (!YAML_FLOAT_PATTERN.test(source)) return NOT_RESOLVED;
  let value = source.toLowerCase().replace(/_/g, "");
  const sign = value[0] === "-" ? -1 : 1;
  if ("+-".includes(value[0])) value = value.slice(1);
  if (value === ".inf") return sign === 1 ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
  if (value === ".nan") return NaN;
  let result = 0;
  if (value.includes(":")) {
    for (const part of value.split(":")) result = result * 60 + Number(part);
    result *= sign;
  } else result = sign * parseFloat(value);
  if (Number.isFinite(result) || YAML_FLOAT_SPECIAL_PATTERN.test(source)) return result;
  return NOT_RESOLVED;
}
function representYamlFloat(object) {
  if (isNaN(object)) return ".nan";
  if (object === Number.POSITIVE_INFINITY) return ".inf";
  if (object === Number.NEGATIVE_INFINITY) return "-.inf";
  if (Object.is(object, -0)) return "-0.0";
  const result = object.toString(10);
  return /^[-+]?[0-9]+e/.test(result) ? result.replace("e", ".e") : result;
}
var floatYaml11Tag = defineScalarTag("tag:yaml.org,2002:float", {
  implicit: true,
  implicitFirstChars: [
    "-",
    "+",
    ".",
    ..."0123456789"
  ],
  resolve: resolveYamlFloat,
  identify: (object) => typeof object === "number" && (!Number.isInteger(object) || Object.is(object, -0) || object.toString(10).indexOf("e") >= 0),
  represent: representYamlFloat
});
var mergeTag = defineScalarTag("tag:yaml.org,2002:merge", {
  implicit: true,
  implicitFirstChars: ["<"],
  resolve: (source, isExplicit) => {
    if (source === "<<" || isExplicit && source === "") return "<<";
    return NOT_RESOLVED;
  },
  identify: () => false
});
var BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;
function resolveYamlBinary(source) {
  const input = source.replace(/\s/g, "");
  if (input.length % 4 !== 0 || !BASE64_PATTERN.test(input)) return NOT_RESOLVED;
  const binary = atob(input);
  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) result[index] = binary.charCodeAt(index);
  return result;
}
function representYamlBinary(object) {
  let binary = "";
  for (let index = 0; index < object.length; index++) binary += String.fromCharCode(object[index]);
  return btoa(binary);
}
var binaryTag = defineScalarTag("tag:yaml.org,2002:binary", {
  resolve: resolveYamlBinary,
  identify: (object) => Object.prototype.toString.call(object) === "[object Uint8Array]",
  represent: representYamlBinary
});
var YAML_DATE_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9])-([0-9][0-9])$");
var YAML_TIMESTAMP_REGEXP = /* @__PURE__ */ new RegExp("^([0-9][0-9][0-9][0-9])-([0-9][0-9]?)-([0-9][0-9]?)(?:[Tt]|[ \\t]+)([0-9][0-9]?):([0-9][0-9]):([0-9][0-9])(?:\\.([0-9]*))?(?:[ \\t]*(Z|([-+])([0-9][0-9]?)(?::([0-9][0-9]))?))?$");
function makeUtcDate(year, month, day, hour = 0, minute = 0, second = 0, fraction = 0) {
  const date = new Date(Date.UTC(year, month, day, hour, minute, second, fraction));
  date.setUTCFullYear(year, month, day);
  return date;
}
function resolveYamlTimestamp(source) {
  let match = YAML_DATE_REGEXP.exec(source);
  if (match === null) match = YAML_TIMESTAMP_REGEXP.exec(source);
  if (match === null) return NOT_RESOLVED;
  const year = +match[1];
  const month = +match[2] - 1;
  const day = +match[3];
  if (!match[4]) {
    const date2 = makeUtcDate(year, month, day);
    if (date2.getUTCFullYear() !== year || date2.getUTCMonth() !== month || date2.getUTCDate() !== day) return NOT_RESOLVED;
    return date2;
  }
  const hour = +match[4];
  const minute = +match[5];
  const second = +match[6];
  let fraction = 0;
  if (hour > 23 || minute > 59 || second > 59) return NOT_RESOLVED;
  if (match[7]) {
    let value = match[7].slice(0, 3);
    while (value.length < 3) value += "0";
    fraction = +value;
  }
  const date = makeUtcDate(year, month, day, hour, minute, second, fraction);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) return NOT_RESOLVED;
  if (match[9]) {
    const offsetHour = +match[10];
    const offsetMinute = +(match[11] || 0);
    if (offsetHour > 23 || offsetMinute > 59) return NOT_RESOLVED;
    const offset = (offsetHour * 60 + offsetMinute) * 6e4;
    date.setTime(date.getTime() - (match[9] === "-" ? -offset : offset));
  }
  return date;
}
var timestampTag = defineScalarTag("tag:yaml.org,2002:timestamp", {
  implicit: true,
  implicitFirstChars: [..."0123456789"],
  resolve: resolveYamlTimestamp,
  identify: (object) => object instanceof Date,
  represent: (object) => object.toISOString()
});
var seqTag = defineSequenceTag("tag:yaml.org,2002:seq", {
  create: () => [],
  addItem: (container, item) => {
    container.push(item);
  },
  identify: Array.isArray
});
function isPlainObject(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  const prototype = Object.getPrototypeOf(data);
  return prototype === null || prototype === Object.prototype;
}
function pick(object, keys) {
  const result = {};
  for (const key of keys) if (object[key] !== void 0) result[key] = object[key];
  return result;
}
var omapTag = defineSequenceTag("tag:yaml.org,2002:omap", {
  create: () => ({
    list: [],
    seen: /* @__PURE__ */ new Set()
  }),
  addItem: (carrier, item) => {
    let key;
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve an ordered map item";
      key = item.keys().next().value;
    } else if (isPlainObject(item)) {
      const itemKeys = Object.keys(item);
      if (itemKeys.length !== 1) return "cannot resolve an ordered map item";
      key = itemKeys[0];
    } else return "cannot resolve an ordered map item";
    if (carrier.seen.has(key)) return "duplicate key in ordered map";
    carrier.seen.add(key);
    carrier.list.push(item);
    return "";
  },
  finalize: (carrier) => carrier.list,
  identify: () => false
});
var pairsTag = defineSequenceTag("tag:yaml.org,2002:pairs", {
  create: () => [],
  addItem: (container, item) => {
    if (item instanceof Map) {
      if (item.size !== 1) return "cannot resolve a pairs item";
      container.push(item.entries().next().value);
      return "";
    }
    if (Object.prototype.toString.call(item) !== "[object Object]") return "cannot resolve a pairs item";
    const object = item;
    const keys = Object.keys(object);
    if (keys.length !== 1) return "cannot resolve a pairs item";
    container.push([keys[0], object[keys[0]]]);
    return "";
  },
  identify: () => false
});
var mapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    if (key !== null && typeof key === "object") return "object-based map does not support complex keys";
    const normalizedKey = String(key);
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    if (key !== null && typeof key === "object") return false;
    return Object.prototype.hasOwnProperty.call(container, String(key));
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var setTag = defineMappingTag("tag:yaml.org,2002:set", {
  create: () => /* @__PURE__ */ new Set(),
  identify: (data) => data instanceof Set,
  represent: (data) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of data) map.set(key, null);
    return map;
  },
  addPair: (container, key, value) => {
    if (value !== null) return "cannot resolve a set item";
    container.add(key);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: () => null
});
function createTagDefinitionMap() {
  return {
    scalar: /* @__PURE__ */ Object.create(null),
    sequence: /* @__PURE__ */ Object.create(null),
    mapping: /* @__PURE__ */ Object.create(null)
  };
}
function createTagDefinitionListMap() {
  return {
    scalar: [],
    sequence: [],
    mapping: []
  };
}
function compileTags(tags) {
  const result = [];
  for (const tag of tags) {
    let index = result.length;
    for (let previousIndex = 0; previousIndex < result.length; previousIndex++) {
      const previous = result[previousIndex];
      if (previous.nodeKind === tag.nodeKind && previous.tagName === tag.tagName && previous.matchByTagPrefix === tag.matchByTagPrefix) {
        index = previousIndex;
        break;
      }
    }
    result[index] = tag;
  }
  return result;
}
var Schema = class Schema2 {
  tags;
  /** @internal */
  implicitScalarTags;
  /**
  * Dispatch implicit scalar resolvers by `source.charAt(0)`. Each bucket holds
  * the resolvers that may match that key, in schema order; a key absent from
  * the map uses
  * {@link Schema.implicitScalarAnyFirstChar}
  * (resolvers that declared no first-char constraint, so they apply to any
  * first character).
  */
  implicitScalarByFirstChar;
  implicitScalarAnyFirstChar;
  /**
  * The default scalar tag (`!!str`), resolved once so the composer's fallback
  * for unresolved plain scalars avoids a keyed lookup per scalar.
  *
  * @internal
  */
  defaultScalarTag;
  /**
  * The default container tags (`!!seq` / `!!map`), used by the dumper: when a
  * value is identified by its default tag, the tag is implicit and not
  * printed. Undefined if the schema does not define them (then such values
  * can't be dumped).
  *
  * @internal
  */
  defaultSequenceTag;
  /** @internal */
  defaultMappingTag;
  exact;
  prefix;
  constructor(tags) {
    const compiledTags = compileTags(tags);
    const implicitScalarTags = [];
    const exact = createTagDefinitionMap();
    const prefix = createTagDefinitionListMap();
    for (const tag of compiledTags) {
      if (tag.nodeKind === "scalar" && tag.implicit) {
        if (tag.matchByTagPrefix) throw new Error("Implicit scalar tags cannot match by tag prefix");
        implicitScalarTags.push(tag);
      }
      switch (tag.nodeKind) {
        case "scalar":
          if (tag.matchByTagPrefix) prefix.scalar.push(tag);
          else exact.scalar[tag.tagName] = tag;
          break;
        case "sequence":
          if (tag.matchByTagPrefix) prefix.sequence.push(tag);
          else exact.sequence[tag.tagName] = tag;
          break;
        case "mapping":
          if (tag.matchByTagPrefix) prefix.mapping.push(tag);
          else exact.mapping[tag.tagName] = tag;
          break;
      }
    }
    const implicitScalarAnyFirstChar = implicitScalarTags.filter((tag) => tag.implicitFirstChars === null);
    const keys = /* @__PURE__ */ new Set();
    for (const tag of implicitScalarTags) if (tag.implicitFirstChars !== null) for (const key of tag.implicitFirstChars) keys.add(key);
    const implicitScalarByFirstChar = /* @__PURE__ */ new Map();
    for (const key of keys) implicitScalarByFirstChar.set(key, implicitScalarTags.filter((tag) => tag.implicitFirstChars === null || tag.implicitFirstChars.indexOf(key) !== -1));
    const defaultScalarTag = exact.scalar["tag:yaml.org,2002:str"];
    if (!defaultScalarTag) throw new Error("schema does not define the default scalar tag (tag:yaml.org,2002:str)");
    this.tags = compiledTags;
    this.implicitScalarTags = implicitScalarTags;
    this.implicitScalarByFirstChar = implicitScalarByFirstChar;
    this.implicitScalarAnyFirstChar = implicitScalarAnyFirstChar;
    this.defaultScalarTag = defaultScalarTag;
    this.defaultSequenceTag = exact.sequence["tag:yaml.org,2002:seq"];
    this.defaultMappingTag = exact.mapping["tag:yaml.org,2002:map"];
    this.exact = exact;
    this.prefix = prefix;
  }
  /** @internal */
  lookupScalarTag(tagName) {
    const exactTag = this.exact.scalar[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.scalar) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupSequenceTag(tagName) {
    const exactTag = this.exact.sequence[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.sequence) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  lookupMappingTag(tagName) {
    const exactTag = this.exact.mapping[tagName];
    if (exactTag) return exactTag;
    for (const tag of this.prefix.mapping) if (tagName.startsWith(tag.tagName)) return tag;
  }
  /** @internal */
  resolveImplicitScalarTag(source) {
    const candidates = this.implicitScalarByFirstChar.get(source.charAt(0)) ?? this.implicitScalarAnyFirstChar;
    for (const tag2 of candidates) {
      const value = tag2.resolve(source, false, tag2.tagName);
      if (value !== NOT_RESOLVED) return {
        value,
        tag: tag2
      };
    }
    const tag = this.defaultScalarTag;
    return {
      value: tag.resolve(source, false, tag.tagName),
      tag
    };
  }
  /**
  * Creates a new schema with the specified tags added. If a tag already
  * exists, it is replaced by the specified tag.
  *
  * @example
  *
  * ```javascript
  * import { CORE_SCHEMA, mergeTag, realMapTag } from 'js-yaml'
  *
  * const schema = CORE_SCHEMA.withTags(mergeTag, realMapTag)
  * ```
  */
  withTags(...tags) {
    let flatTags = [];
    for (const tag of tags) flatTags = flatTags.concat(tag);
    return new Schema2([...this.tags, ...flatTags]);
  }
};
var FAILSAFE_SCHEMA = new Schema([
  strTag,
  seqTag,
  mapTag
]);
var JSON_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullJsonTag,
  boolJsonTag,
  intJsonTag,
  floatJsonTag
]);
var CORE_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullCoreTag,
  boolCoreTag,
  intCoreTag,
  floatCoreTag
]);
var YAML11_SCHEMA = new Schema([
  ...FAILSAFE_SCHEMA.tags,
  nullYaml11Tag,
  boolYaml11Tag,
  intYaml11Tag,
  floatYaml11Tag,
  timestampTag,
  mergeTag,
  binaryTag,
  omapTag,
  pairsTag,
  setTag
]);
var DUMP_SCHEMA = YAML11_SCHEMA.withTags({
  ...intYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = intYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? intCoreTag.resolve(source, isExplicit, tagName) : result;
  }
}, {
  ...floatYaml11Tag,
  resolve: (source, isExplicit, tagName) => {
    const result = floatYaml11Tag.resolve(source, isExplicit, tagName);
    return result === NOT_RESOLVED ? floatCoreTag.resolve(source, isExplicit, tagName) : result;
  }
});
var realMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => /* @__PURE__ */ new Map(),
  addPair: (container, key, value) => {
    container.set(key, value);
    return "";
  },
  has: (container, key) => container.has(key),
  keys: (container) => container.keys(),
  get: (container, key) => container.get(key),
  identify: (data) => data instanceof Map || isPlainObject(data),
  represent: (data) => {
    if (data instanceof Map) return data;
    const map = /* @__PURE__ */ new Map();
    const obj = data;
    for (const key of Object.keys(obj)) map.set(key, obj[key]);
    return map;
  }
});
function normalizeKey(key) {
  if (Array.isArray(key)) {
    const array = Array.prototype.slice.call(key);
    for (let index = 0; index < array.length; index++) {
      if (Array.isArray(array[index])) return null;
      if (typeof array[index] === "object" && Object.prototype.toString.call(array[index]) === "[object Object]") array[index] = "[object Object]";
    }
    return String(array);
  }
  if (typeof key === "object" && Object.prototype.toString.call(key) === "[object Object]") return "[object Object]";
  return String(key);
}
var legacyMapTag = defineMappingTag("tag:yaml.org,2002:map", {
  create: () => ({}),
  identify: isPlainObject,
  represent: (o) => {
    const map = /* @__PURE__ */ new Map();
    for (const key of Object.keys(o)) map.set(key, o[key]);
    return map;
  },
  addPair: (container, key, value) => {
    const normalizedKey = normalizeKey(key);
    if (normalizedKey === null) return "nested arrays are not supported inside keys";
    if (normalizedKey === "__proto__") Object.defineProperty(container, normalizedKey, {
      value,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else container[normalizedKey] = value;
    return "";
  },
  has: (container, key) => {
    const normalizedKey = normalizeKey(key);
    return normalizedKey !== null && Object.prototype.hasOwnProperty.call(container, normalizedKey);
  },
  keys: (container) => Object.keys(container),
  get: (container, key) => {
    const normalizedKey = String(key);
    if (!Object.prototype.hasOwnProperty.call(container, normalizedKey)) return null;
    return container[normalizedKey];
  }
});
var DEFAULT_SNIPPET_OPTIONS = {
  maxLength: 79,
  indent: 1,
  linesBefore: 3,
  linesAfter: 2
};
function getLine(buffer, lineStart, lineEnd, position, maxLineLength) {
  let head = "";
  let tail = "";
  const maxHalfLength = Math.floor(maxLineLength / 2) - 1;
  if (position - lineStart > maxHalfLength) {
    head = " ... ";
    lineStart = position - maxHalfLength + head.length;
  }
  if (lineEnd - position > maxHalfLength) {
    tail = " ...";
    lineEnd = position + maxHalfLength - tail.length;
  }
  return {
    str: head + buffer.slice(lineStart, lineEnd).replace(/\t/g, "\u2192") + tail,
    pos: position - lineStart + head.length
  };
}
function padStart(string, max) {
  return " ".repeat(Math.max(max - string.length, 0)) + string;
}
function makeSnippet(mark, options) {
  if (!mark.buffer) return null;
  const opts = {
    ...DEFAULT_SNIPPET_OPTIONS,
    ...options
  };
  const re = /\r?\n|\r|\0/g;
  const lineStarts = [0];
  const lineEnds = [];
  let match;
  let foundLineNo = -1;
  while (match = re.exec(mark.buffer)) {
    lineEnds.push(match.index);
    lineStarts.push(match.index + match[0].length);
    if (mark.position <= match.index && foundLineNo < 0) foundLineNo = lineStarts.length - 2;
  }
  if (foundLineNo < 0) foundLineNo = lineStarts.length - 1;
  let result = "";
  const lineNoLength = Math.min(mark.line + opts.linesAfter, lineEnds.length).toString().length;
  const maxLineLength = opts.maxLength - (opts.indent + lineNoLength + 3);
  for (let i = 1; i <= opts.linesBefore; i++) {
    if (foundLineNo - i < 0) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo - i], lineEnds[foundLineNo - i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo - i]), maxLineLength);
    result = `${" ".repeat(opts.indent)}${padStart((mark.line - i + 1).toString(), lineNoLength)} | ${line2.str}
${result}`;
  }
  const line = getLine(mark.buffer, lineStarts[foundLineNo], lineEnds[foundLineNo], mark.position, maxLineLength);
  result += `${" ".repeat(opts.indent)}${padStart((mark.line + 1).toString(), lineNoLength)} | ${line.str}
`;
  result += `${"-".repeat(opts.indent + lineNoLength + 3 + line.pos)}^
`;
  for (let i = 1; i <= opts.linesAfter; i++) {
    if (foundLineNo + i >= lineEnds.length) break;
    const line2 = getLine(mark.buffer, lineStarts[foundLineNo + i], lineEnds[foundLineNo + i], mark.position - (lineStarts[foundLineNo] - lineStarts[foundLineNo + i]), maxLineLength);
    result += `${" ".repeat(opts.indent)}${padStart((mark.line + i + 1).toString(), lineNoLength)} | ${line2.str}
`;
  }
  return result.replace(/\n$/, "");
}
function formatError(exception, compact) {
  let where = "";
  if (!exception.mark) return exception.reason;
  if (exception.mark.name) where += `in "${exception.mark.name}" `;
  where += `(${exception.mark.line + 1}:${exception.mark.column + 1})`;
  if (!compact && exception.mark.snippet) where += `

${exception.mark.snippet}`;
  return `${exception.reason} ${where}`;
}
var YAMLException = class YAMLException2 extends Error {
  reason;
  mark;
  /**
  * Optional `mark` contains source snippet data. Usually, use
  * {@link YAMLException.throwAt} instead of passing it directly.
  */
  constructor(reason, mark) {
    super();
    this.name = "YAMLException";
    this.reason = reason;
    this.mark = mark;
    this.message = formatError(this, false);
    if (Error.captureStackTrace) Error.captureStackTrace(this, this.constructor);
  }
  /**
  * Returns the formatted error, omitting the source snippet in compact mode.
  */
  toString(compact) {
    return `${this.name}: ${formatError(this, compact)}`;
  }
  /**
  * Builds a YAMLException with a source snippet and throws it. `source` is
  * the raw input text; `position` is an offset into it.
  */
  static throwAt(source, position, message, filename = "") {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < position; index++) {
      const ch = source.charCodeAt(index);
      if (ch === 10) {
        line++;
        lineStart = index + 1;
      } else if (ch === 13) {
        line++;
        if (source.charCodeAt(index + 1) === 10) index++;
        lineStart = index + 1;
      }
    }
    const mark = {
      name: filename,
      buffer: source,
      position,
      line,
      column: position - lineStart
    };
    mark.snippet = makeSnippet(mark);
    throw new YAMLException2(message, mark);
  }
};
var EVENT_ID = {
  DOCUMENT: 1,
  SEQUENCE: 2,
  MAPPING: 3,
  SCALAR: 4,
  ALIAS: 5,
  POP: 6
};
var SCALAR_STYLE = {
  PLAIN: 1,
  SINGLE_QUOTED: 2,
  DOUBLE_QUOTED: 3,
  LITERAL_BLOCK: 4,
  FOLDED_BLOCK: 5
};
var COLLECTION_STYLE = {
  BLOCK: 1,
  FLOW: 2
};
var CHOMPING_MODE = {
  CLIP: 1,
  STRIP: 2,
  KEEP: 3
};
var NO_RANGE$3 = -1;
function simpleEscapeSequence(c) {
  switch (c) {
    case 48:
      return "\0";
    case 97:
      return "\x07";
    case 98:
      return "\b";
    case 116:
      return "	";
    case 9:
      return "	";
    case 110:
      return "\n";
    case 118:
      return "\v";
    case 102:
      return "\f";
    case 114:
      return "\r";
    case 101:
      return "\x1B";
    case 32:
      return " ";
    case 34:
      return '"';
    case 47:
      return "/";
    case 92:
      return "\\";
    case 78:
      return "\x85";
    case 95:
      return "\xA0";
    case 76:
      return "\u2028";
    case 80:
      return "\u2029";
    default:
      return "";
  }
}
var simpleEscapeCheck = new Array(256);
var simpleEscapeMap = new Array(256);
for (let i = 0; i < 256; i++) {
  simpleEscapeCheck[i] = simpleEscapeSequence(i) ? 1 : 0;
  simpleEscapeMap[i] = simpleEscapeSequence(i);
}
function charFromCodepoint(c) {
  if (c <= 65535) return String.fromCharCode(c);
  return String.fromCharCode((c - 65536 >> 10) + 55296, (c - 65536 & 1023) + 56320);
}
function fromHexCode$1(c) {
  if (c >= 48 && c <= 57) return c - 48;
  return (c | 32) - 97 + 10;
}
function escapedHexLen$1(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  return 8;
}
function skipFoldedBreaks(input, position, end) {
  let breaks = 0;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10) {
      breaks++;
      position++;
    } else if (ch === 13) {
      breaks++;
      position++;
      if (input.charCodeAt(position) === 10) position++;
    } else if (ch === 32 || ch === 9) position++;
    else break;
  }
  return {
    position,
    breaks
  };
}
function foldedBreaks(count) {
  if (count === 1) return " ";
  return "\n".repeat(count - 1);
}
function getPlainValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, captureEnd);
}
function getSingleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 39) {
      result += input.slice(captureStart, position) + "'";
      position += 2;
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getDoubleQuotedValue(input, start, end) {
  let result = "";
  let position = start;
  let captureStart = start;
  let captureEnd = start;
  while (position < end) {
    const ch = input.charCodeAt(position);
    if (ch === 92) {
      result += input.slice(captureStart, position);
      position++;
      const escaped = input.charCodeAt(position);
      if (escaped === 10 || escaped === 13) position = skipFoldedBreaks(input, position, end).position;
      else if (escaped < 256 && simpleEscapeCheck[escaped]) {
        result += simpleEscapeMap[escaped];
        position++;
      } else {
        let hexLength = escapedHexLen$1(escaped);
        let hexResult = 0;
        for (; hexLength > 0; hexLength--) {
          position++;
          const digit = fromHexCode$1(input.charCodeAt(position));
          hexResult = (hexResult << 4) + digit;
        }
        result += charFromCodepoint(hexResult);
        position++;
      }
      captureStart = captureEnd = position;
    } else if (ch === 10 || ch === 13) {
      result += input.slice(captureStart, captureEnd);
      const fold = skipFoldedBreaks(input, position, end);
      result += foldedBreaks(fold.breaks);
      position = captureStart = captureEnd = fold.position;
    } else {
      position++;
      if (ch !== 32 && ch !== 9) captureEnd = position;
    }
  }
  return result + input.slice(captureStart, end);
}
function getBlockValue(input, start, end, indent, chomping, folded) {
  const textIndent = indent < 0 ? 0 : indent;
  const region = input.slice(start, end).replace(/\r\n?/g, "\n");
  const lines = region === "" ? [] : (region.endsWith("\n") ? region.slice(0, -1) : region).split("\n");
  let result = "";
  let didReadContent = false;
  let emptyLines = 0;
  let atMoreIndented = false;
  for (const line of lines) {
    let column = 0;
    while (column < textIndent && line.charCodeAt(column) === 32) column++;
    if (indent < 0 || column >= line.length) {
      emptyLines++;
      continue;
    }
    const content = line.slice(textIndent);
    const first = content.charCodeAt(0);
    if (folded) if (first === 32 || first === 9) {
      atMoreIndented = true;
      result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    } else if (atMoreIndented) {
      atMoreIndented = false;
      result += "\n".repeat(emptyLines + 1);
    } else if (emptyLines === 0) {
      if (didReadContent) result += " ";
    } else result += "\n".repeat(emptyLines);
    else result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
    result += content;
    didReadContent = true;
    emptyLines = 0;
  }
  if (chomping === CHOMPING_MODE.KEEP) result += "\n".repeat(didReadContent ? 1 + emptyLines : emptyLines);
  else if (chomping !== CHOMPING_MODE.STRIP) {
    if (didReadContent) result += "\n";
  }
  return result;
}
function getScalarValue(input, scalar) {
  if (scalar.valueStart === NO_RANGE$3) return "";
  const { valueStart, valueEnd } = scalar;
  if (scalar.fast) return input.slice(valueStart, valueEnd);
  switch (scalar.style) {
    case SCALAR_STYLE.SINGLE_QUOTED:
      return getSingleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.DOUBLE_QUOTED:
      return getDoubleQuotedValue(input, valueStart, valueEnd);
    case SCALAR_STYLE.LITERAL_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, false);
    case SCALAR_STYLE.FOLDED_BLOCK:
      return getBlockValue(input, valueStart, valueEnd, scalar.indent, scalar.chomping, true);
    default:
      return getPlainValue(input, valueStart, valueEnd);
  }
}
var DEFAULT_TAG_HANDLERS = Object.assign(/* @__PURE__ */ Object.create(null), {
  "!": "!",
  "!!": "tag:yaml.org,2002:"
});
function tagNameFull(rawTag, tagHandlers) {
  if (rawTag.startsWith("!<") && rawTag.endsWith(">")) return decodeURIComponent(rawTag.slice(2, -1));
  const handleEnd = rawTag.indexOf("!", 1);
  const handle = handleEnd === -1 ? "!" : rawTag.slice(0, handleEnd + 1);
  const prefix = tagHandlers?.[handle] ?? DEFAULT_TAG_HANDLERS[handle] ?? handle;
  return decodeURIComponent(prefix) + decodeURIComponent(rawTag.slice(handle.length));
}
var NO_RANGE$2 = -1;
var MERGE_TAG_NAME = "tag:yaml.org,2002:merge";
var DEFAULT_CONSTRUCTOR_OPTIONS = {
  filename: "",
  schema: CORE_SCHEMA,
  json: false,
  maxTotalMergeKeys: 1e4,
  maxAliases: -1
};
function eventPosition$1(event) {
  if ("tagStart" in event && event.tagStart !== NO_RANGE$2) return event.tagStart;
  if ("anchorStart" in event && event.anchorStart !== NO_RANGE$2) return event.anchorStart;
  if ("valueStart" in event && event.valueStart !== NO_RANGE$2) return event.valueStart;
  if ("start" in event) return event.start;
  return 0;
}
function throwError$1(state, message) {
  YAMLException.throwAt(state.source, state.position, message, state.filename);
}
function finalizeCollection(state, position, tag, carrier) {
  try {
    return tag.finalize(carrier);
  } catch (error) {
    if (error instanceof YAMLException) throw error;
    YAMLException.throwAt(state.source, position, error instanceof Error ? error.message : String(error), state.filename);
  }
}
function constructScalar(state, event) {
  const source = getScalarValue(state.source, event);
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  const strTag2 = state.schema.defaultScalarTag;
  if (rawTag !== "") {
    if (rawTag === "!") return {
      value: source,
      tag: strTag2
    };
    const tagName = tagNameFull(rawTag, state.tagHandlers);
    const scalarTag = state.schema.lookupScalarTag(tagName);
    if (scalarTag) {
      const result = scalarTag.resolve(source, true, tagName);
      if (result === NOT_RESOLVED) throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      return {
        value: result,
        tag: scalarTag
      };
    }
    const collectionTagDef = state.schema.lookupMappingTag(tagName) ?? state.schema.lookupSequenceTag(tagName);
    if (collectionTagDef) {
      if (source !== "") throwError$1(state, `cannot resolve a node with !<${tagName}> explicit tag`);
      const carrier = collectionTagDef.create(tagName);
      return {
        value: collectionTagDef.carrierIsResult ? carrier : finalizeCollection(state, state.position, collectionTagDef, carrier),
        tag: collectionTagDef
      };
    }
    throwError$1(state, `unknown scalar tag !<${tagName}>`);
  }
  if (event.style === SCALAR_STYLE.PLAIN) return state.schema.resolveImplicitScalarTag(source);
  return {
    value: strTag2.resolve(source, false, strTag2.tagName),
    tag: strTag2
  };
}
function collectionTagName(state, event, defaultTagName) {
  const rawTag = event.tagStart === NO_RANGE$2 ? "" : state.source.slice(event.tagStart, event.tagEnd);
  return rawTag === "" || rawTag === "!" ? defaultTagName : tagNameFull(rawTag, state.tagHandlers);
}
function isMappingTag(tag) {
  return tag.nodeKind === "mapping";
}
function chargeMergeWork(state) {
  state.totalMergeKeys++;
  if (state.maxTotalMergeKeys !== -1 && state.totalMergeKeys > state.maxTotalMergeKeys) throwError$1(state, `merge keys exceeded maxTotalMergeKeys (${state.maxTotalMergeKeys})`);
}
function mergeKeys(state, frame, source, sourceTag) {
  chargeMergeWork(state);
  for (const sourceKey of sourceTag.keys(source)) {
    chargeMergeWork(state);
    if (frame.tag.has(frame.value, sourceKey)) continue;
    const err = frame.tag.addPair(frame.value, sourceKey, sourceTag.get(source, sourceKey));
    if (err) throwError$1(state, err);
    frame.overridable ??= /* @__PURE__ */ new Set();
    frame.overridable.add(sourceKey);
  }
}
function mergeSource(state, frame, source, sourceTag) {
  state.position = frame.keyPosition;
  if (isMappingTag(sourceTag)) mergeKeys(state, frame, source, sourceTag);
  else if (sourceTag.nodeKind === "sequence" && Array.isArray(source)) {
    if (source.length > 100) throwError$1(state, "abnormal merge sequence size");
    for (const element of source) {
      const elementTag = state.nodeTags.get(element);
      if (!elementTag) throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
      mergeKeys(state, frame, element, elementTag);
    }
  } else throwError$1(state, "cannot merge mappings; the provided source object is unacceptable");
}
function addMappingValue(state, frame, key, value, tag) {
  state.position = frame.keyPosition;
  if (frame.keyIsMerge) {
    mergeSource(state, frame, value, tag);
    return;
  }
  if (!state.json && frame.tag.has(frame.value, key) && !frame.overridable?.has(key)) throwError$1(state, "duplicated mapping key");
  const err = frame.tag.addPair(frame.value, key, value);
  if (err) throwError$1(state, err);
  frame.overridable?.delete(key);
}
function addValue(state, value, tag) {
  const frame = state.frames[state.frames.length - 1];
  if (frame.kind === "document") {
    frame.value = value;
    frame.hasValue = true;
  } else if (frame.kind === "sequence") {
    if (isMappingTag(tag)) state.nodeTags.set(value, tag);
    const err = frame.tag.addItem(frame.value, value, frame.index++);
    if (err) throwError$1(state, err);
  } else if (frame.hasKey) {
    const key = frame.key;
    frame.key = void 0;
    frame.hasKey = false;
    addMappingValue(state, frame, key, value, tag);
  } else {
    frame.key = value;
    frame.keyPosition = state.position;
    frame.hasKey = true;
    frame.keyIsMerge = tag.tagName === MERGE_TAG_NAME;
  }
}
function storeAnchor(state, event, value, tag, isValueFinal) {
  if (event.anchorStart !== NO_RANGE$2) {
    const anchor = {
      value,
      tag,
      isValueFinal
    };
    state.anchors.set(state.source.slice(event.anchorStart, event.anchorEnd), anchor);
    return anchor;
  }
  return null;
}
function constructFromEvents(events, options) {
  const state = {
    ...DEFAULT_CONSTRUCTOR_OPTIONS,
    ...options,
    events,
    documents: [],
    eventIndex: 0,
    position: 0,
    frames: [],
    anchors: /* @__PURE__ */ new Map(),
    nodeTags: /* @__PURE__ */ new Map(),
    tagHandlers: /* @__PURE__ */ Object.create(null),
    totalMergeKeys: 0,
    aliasCount: 0
  };
  while (state.eventIndex < state.events.length) {
    const event = state.events[state.eventIndex++];
    state.position = eventPosition$1(event);
    switch (event.type) {
      case EVENT_ID.DOCUMENT:
        state.anchors = /* @__PURE__ */ new Map();
        state.nodeTags = /* @__PURE__ */ new Map();
        state.aliasCount = 0;
        state.tagHandlers = /* @__PURE__ */ Object.create(null);
        for (const directive of event.directives) if (directive.kind === "tag") state.tagHandlers[directive.handle] = directive.prefix;
        state.frames.push({
          kind: "document",
          position: state.position,
          value: void 0,
          hasValue: false
        });
        break;
      case EVENT_ID.SCALAR: {
        const { value, tag } = constructScalar(state, event);
        storeAnchor(state, event, value, tag, true);
        addValue(state, value, tag);
        break;
      }
      case EVENT_ID.SEQUENCE: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:seq");
        const tag = state.schema.lookupSequenceTag(tagName);
        if (!tag) throwError$1(state, `unknown sequence tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "sequence",
          position: state.position,
          value,
          tag,
          anchor,
          index: 0
        });
        break;
      }
      case EVENT_ID.MAPPING: {
        const tagName = collectionTagName(state, event, "tag:yaml.org,2002:map");
        const tag = state.schema.lookupMappingTag(tagName);
        if (!tag) throwError$1(state, `unknown mapping tag !<${tagName}>`);
        const value = tag.create(tagName);
        const anchor = storeAnchor(state, event, value, tag, tag.carrierIsResult);
        state.frames.push({
          kind: "mapping",
          position: state.position,
          value,
          tag,
          anchor,
          key: void 0,
          keyPosition: state.position,
          hasKey: false,
          keyIsMerge: false,
          overridable: null
        });
        break;
      }
      case EVENT_ID.ALIAS: {
        if (state.maxAliases !== -1 && ++state.aliasCount > state.maxAliases) throwError$1(state, `aliases exceeded maxAliases (${state.maxAliases})`);
        const name = state.source.slice(event.anchorStart, event.anchorEnd);
        const anchor = state.anchors.get(name);
        if (!anchor) throwError$1(state, `unidentified alias "${name}"`);
        if (!anchor.isValueFinal) throwError$1(state, `recursive alias "${name}" is not supported for tag ${anchor.tag.tagName} because it uses finalize()`);
        addValue(state, anchor.value, anchor.tag);
        break;
      }
      case EVENT_ID.POP: {
        const frame = state.frames.pop();
        if (frame.kind === "mapping" && frame.hasKey) {
          state.position = frame.keyPosition;
          throwError$1(state, "incomplete mapping pair in event stream");
        }
        if (frame.kind === "document") state.documents.push(frame.value);
        else {
          const value = frame.tag.carrierIsResult ? frame.value : finalizeCollection(state, frame.position, frame.tag, frame.value);
          if (frame.anchor) {
            frame.anchor.value = value;
            frame.anchor.isValueFinal = true;
          }
          addValue(state, value, frame.tag);
        }
        break;
      }
    }
  }
  return state.documents;
}
var NO_RANGE$1 = -1;
var HAS_OWN = Object.prototype.hasOwnProperty;
var CONTEXT_FLOW_IN = 1;
var CONTEXT_FLOW_OUT = 2;
var CONTEXT_BLOCK_IN = 3;
var CONTEXT_BLOCK_OUT = 4;
var PATTERN_NON_PRINTABLE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F-\x84\x86-\x9F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:[^\uD800-\uDBFF]|^)[\uDC00-\uDFFF]/;
var PATTERN_FLOW_INDICATORS = /[,\[\]{}]/;
var PATTERN_TAG_HANDLE = /^(?:!|!!|![0-9A-Za-z-]+!)$/;
var NS_URI_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$,_.!~*'()\[\]])`;
var NS_TAG_CHAR = String.raw`(?:%[0-9A-Fa-f]{2}|[0-9A-Za-z\-#;/?:@&=+$.~*'()_])`;
var PATTERN_TAG_URI = new RegExp(`^(?:${NS_URI_CHAR})*$`);
var PATTERN_TAG_SUFFIX = new RegExp(`^(?:${NS_TAG_CHAR})+$`);
var PATTERN_TAG_PREFIX = new RegExp(`^(?:!(?:${NS_URI_CHAR})*|${NS_TAG_CHAR}(?:${NS_URI_CHAR})*)$`);
var DEFAULT_PARSER_OPTIONS = {
  filename: "",
  maxDepth: 100
};
function addDocumentEvent(state, explicitStart, explicitEnd) {
  state.events.push({
    type: EVENT_ID.DOCUMENT,
    explicitStart,
    explicitEnd,
    directives: state.directives
  });
}
function addSequenceEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.SEQUENCE,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function addMappingEvent(state, start, anchorStart, anchorEnd, tagStart, tagEnd, style) {
  state.events.push({
    type: EVENT_ID.MAPPING,
    start,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style
  });
}
function insertFlowPairMappingEvent(state, snapshot) {
  state.events.splice(snapshot.eventsLength, 0, {
    type: EVENT_ID.MAPPING,
    start: snapshot.position,
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1,
    style: COLLECTION_STYLE.FLOW
  });
}
function addScalarEvent(state, valueStart, valueEnd, anchorStart, anchorEnd, tagStart, tagEnd, style, chomping = CHOMPING_MODE.CLIP, indent = -1, fast = false) {
  state.events.push({
    type: EVENT_ID.SCALAR,
    valueStart,
    valueEnd,
    anchorStart,
    anchorEnd,
    tagStart,
    tagEnd,
    style,
    chomping,
    indent,
    fast
  });
}
function addAliasEvent(state, anchorStart, anchorEnd) {
  state.events.push({
    type: EVENT_ID.ALIAS,
    anchorStart,
    anchorEnd
  });
}
function addPopEvent(state) {
  state.events.push({ type: EVENT_ID.POP });
}
function addEmptyScalarEvent(state) {
  addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, NO_RANGE$1, SCALAR_STYLE.PLAIN);
}
function emptyProperties() {
  return {
    anchorStart: NO_RANGE$1,
    anchorEnd: NO_RANGE$1,
    tagStart: NO_RANGE$1,
    tagEnd: NO_RANGE$1
  };
}
function snapshotState(state) {
  return {
    position: state.position,
    line: state.line,
    lineStart: state.lineStart,
    lineIndent: state.lineIndent,
    firstTabInLine: state.firstTabInLine,
    eventsLength: state.events.length
  };
}
function restoreState(state, snapshot) {
  state.position = snapshot.position;
  state.line = snapshot.line;
  state.lineStart = snapshot.lineStart;
  state.lineIndent = snapshot.lineIndent;
  state.firstTabInLine = snapshot.firstTabInLine;
  state.events.length = snapshot.eventsLength;
}
function throwError(state, message) {
  YAMLException.throwAt(state.input.slice(0, state.length), state.position, message, state.filename);
}
function isEol(c) {
  return c === 10 || c === 13;
}
function isWhiteSpace(c) {
  return c === 9 || c === 32;
}
function isWsOrEol(c) {
  return isWhiteSpace(c) || isEol(c);
}
function isWsOrEolOrEnd(c) {
  return c === 0 || isWsOrEol(c);
}
function isFlowIndicator(c) {
  return c === 44 || c === 91 || c === 93 || c === 123 || c === 125;
}
function fromDecimalCode(c) {
  return c >= 48 && c <= 57 ? c - 48 : -1;
}
function fromHexCode(c) {
  if (c >= 48 && c <= 57) return c - 48;
  const lc = c | 32;
  if (lc >= 97 && lc <= 102) return lc - 97 + 10;
  return -1;
}
function escapedHexLen(c) {
  if (c === 120) return 2;
  if (c === 117) return 4;
  if (c === 85) return 8;
  return 0;
}
function isSimpleEscape(c) {
  return c === 48 || c === 97 || c === 98 || c === 116 || c === 9 || c === 110 || c === 118 || c === 102 || c === 114 || c === 101 || c === 32 || c === 34 || c === 47 || c === 92 || c === 78 || c === 95 || c === 76 || c === 80;
}
function consumeLineBreak(state) {
  if (state.input.charCodeAt(state.position) === 10) state.position++;
  else {
    state.position++;
    if (state.input.charCodeAt(state.position) === 10) state.position++;
  }
  state.line++;
  state.lineStart = state.position;
  state.lineIndent = 0;
  state.firstTabInLine = -1;
}
function skipSeparationSpace(state, allowComments) {
  let lineBreaks = 0;
  let ch = state.input.charCodeAt(state.position);
  let hasSeparation = state.position === state.lineStart || isWsOrEol(state.input.charCodeAt(state.position - 1));
  while (ch !== 0) {
    while (isWhiteSpace(ch)) {
      hasSeparation = true;
      if (ch === 9 && state.firstTabInLine === -1) state.firstTabInLine = state.position;
      ch = state.input.charCodeAt(++state.position);
    }
    if (allowComments && hasSeparation && ch === 35) do
      ch = state.input.charCodeAt(++state.position);
    while (!isEol(ch) && ch !== 0);
    if (!isEol(ch)) break;
    consumeLineBreak(state);
    lineBreaks++;
    hasSeparation = true;
    ch = state.input.charCodeAt(state.position);
    while (ch === 32) {
      state.lineIndent++;
      ch = state.input.charCodeAt(++state.position);
    }
  }
  return lineBreaks;
}
function testDocumentSeparator(state, position = state.position) {
  const ch = state.input.charCodeAt(position);
  if ((ch === 45 || ch === 46) && ch === state.input.charCodeAt(position + 1) && ch === state.input.charCodeAt(position + 2)) {
    const following = state.input.charCodeAt(position + 3);
    return following === 0 || isWsOrEol(following);
  }
  return false;
}
function skipByteOrderMark(state) {
  if (state.position === state.lineStart && state.input.charCodeAt(state.position) === 65279) {
    state.position++;
    state.lineStart = state.position;
  }
}
function testDocumentBoundary(state) {
  if (state.position !== state.lineStart) return false;
  if (testDocumentSeparator(state)) return true;
  if (state.input.charCodeAt(state.position) !== 65279) return false;
  const snapshot = snapshotState(state);
  skipByteOrderMark(state);
  skipSeparationSpace(state, true);
  const ch = state.input.charCodeAt(state.position);
  const result = state.position === state.lineStart && (ch === 37 || ch === 45 && testDocumentSeparator(state));
  restoreState(state, snapshot);
  return result;
}
function skipUntilLineEnd(state) {
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0 && !isEol(ch)) ch = state.input.charCodeAt(++state.position);
}
function checkPrintable(state, start, end) {
  if (PATTERN_NON_PRINTABLE.test(state.input.slice(start, end))) throwError(state, "the stream contains non-printable characters");
}
function readTagProperty(state, props, inFlow) {
  if (state.input.charCodeAt(state.position) !== 33) return false;
  if (props.tagStart !== NO_RANGE$1) throwError(state, "duplication of a tag property");
  const start = state.position;
  let isVerbatim = false;
  let isNamed = false;
  let tagHandle = "!";
  let ch = state.input.charCodeAt(++state.position);
  if (ch === 60) {
    isVerbatim = true;
    ch = state.input.charCodeAt(++state.position);
  } else if (ch === 33) {
    isNamed = true;
    tagHandle = "!!";
    ch = state.input.charCodeAt(++state.position);
  }
  let suffixStart = state.position;
  let tagName;
  if (isVerbatim) {
    while (ch !== 0 && ch !== 62) ch = state.input.charCodeAt(++state.position);
    if (ch !== 62) throwError(state, "unexpected end of the stream within a verbatim tag");
    tagName = state.input.slice(suffixStart, state.position);
    state.position++;
  } else {
    while (ch !== 0 && !isWsOrEol(ch) && !(inFlow && isFlowIndicator(ch))) {
      if (ch === 33) if (!isNamed) {
        tagHandle = state.input.slice(suffixStart - 1, state.position + 1);
        if (!PATTERN_TAG_HANDLE.test(tagHandle)) throwError(state, "named tag handle cannot contain such characters");
        isNamed = true;
        suffixStart = state.position + 1;
      } else throwError(state, "tag suffix cannot contain exclamation marks");
      ch = state.input.charCodeAt(++state.position);
    }
    tagName = state.input.slice(suffixStart, state.position);
    if (PATTERN_FLOW_INDICATORS.test(tagName)) throwError(state, "tag suffix cannot contain flow indicator characters");
  }
  if (tagName && !(isVerbatim ? PATTERN_TAG_URI.test(tagName) : PATTERN_TAG_SUFFIX.test(tagName))) throwError(state, `tag name cannot contain such characters: ${tagName}`);
  if (!isVerbatim && tagHandle !== "!" && tagHandle !== "!!" && !HAS_OWN.call(state.tagHandlers, tagHandle)) throwError(state, `undeclared tag handle "${tagHandle}"`);
  props.tagStart = start;
  props.tagEnd = state.position;
  return true;
}
function readAnchorProperty(state, props) {
  if (state.input.charCodeAt(state.position) !== 38) return false;
  if (props.anchorStart !== NO_RANGE$1) throwError(state, "duplication of an anchor property");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an anchor node must contain at least one character");
  props.anchorStart = start;
  props.anchorEnd = state.position;
  return true;
}
function readAlias(state, props) {
  if (state.input.charCodeAt(state.position) !== 42) return false;
  if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) throwError(state, "alias node should not have any properties");
  state.position++;
  const start = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position)) && !isFlowIndicator(state.input.charCodeAt(state.position))) state.position++;
  if (state.position === start) throwError(state, "name of an alias node must contain at least one character");
  addAliasEvent(state, start, state.position);
  return true;
}
function readFlowScalarBreak(state, nodeIndent) {
  skipSeparationSpace(state, false);
  if (state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readSingleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 39) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 39) {
      if (state.input.charCodeAt(state.position + 1) === 39) {
        simple = false;
        state.position += 2;
        continue;
      }
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.SINGLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a single quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a single quoted scalar");
}
function readDoubleQuotedScalar(state, nodeIndent, props) {
  if (state.input.charCodeAt(state.position) !== 34) return false;
  state.position++;
  const start = state.position;
  let simple = true;
  while (state.input.charCodeAt(state.position) !== 0) {
    const ch = state.input.charCodeAt(state.position);
    if (ch === 34) {
      const end = state.position;
      state.position++;
      addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.DOUBLE_QUOTED, CHOMPING_MODE.CLIP, -1, simple);
      return true;
    }
    if (ch === 92) {
      simple = false;
      const escaped = state.input.charCodeAt(++state.position);
      if (isEol(escaped)) readFlowScalarBreak(state, nodeIndent);
      else if (isSimpleEscape(escaped)) state.position++;
      else {
        let hexLength = escapedHexLen(escaped);
        if (hexLength === 0) throwError(state, "unknown escape sequence");
        while (hexLength-- > 0) {
          state.position++;
          if (fromHexCode(state.input.charCodeAt(state.position)) < 0) throwError(state, "expected hexadecimal character");
        }
        state.position++;
      }
    } else if (isEol(ch)) {
      simple = false;
      readFlowScalarBreak(state, nodeIndent);
    } else if (state.position === state.lineStart && testDocumentSeparator(state)) throwError(state, "unexpected end of the document within a double quoted scalar");
    else if (ch !== 9 && ch < 32) throwError(state, "expected valid JSON character");
    else state.position++;
  }
  throwError(state, "unexpected end of the stream within a double quoted scalar");
}
function readBlockScalar(state, parentIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  let chomping = CHOMPING_MODE.CLIP;
  let indent = -1;
  let detectedIndent = false;
  if (ch !== 124 && ch !== 62) return false;
  const style = ch === 124 ? SCALAR_STYLE.LITERAL_BLOCK : SCALAR_STYLE.FOLDED_BLOCK;
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    const current = state.input.charCodeAt(state.position);
    const digit = fromDecimalCode(current);
    if (current === 43 || current === 45) {
      if (chomping !== CHOMPING_MODE.CLIP) throwError(state, "repeat of a chomping mode identifier");
      chomping = current === 43 ? CHOMPING_MODE.KEEP : CHOMPING_MODE.STRIP;
      state.position++;
    } else if (digit >= 0) {
      if (digit === 0) throwError(state, "bad explicit indentation width of a block scalar; it cannot be less than one");
      if (detectedIndent) throwError(state, "repeat of an indentation width identifier");
      indent = parentIndent + digit - 1;
      detectedIndent = true;
      state.position++;
    } else break;
  }
  let hadWhitespace = false;
  while (isWhiteSpace(state.input.charCodeAt(state.position))) {
    hadWhitespace = true;
    state.position++;
  }
  if (hadWhitespace && state.input.charCodeAt(state.position) === 35) skipUntilLineEnd(state);
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  else if (state.input.charCodeAt(state.position) !== 0) throwError(state, "a line break is expected");
  let contentIndent = detectedIndent ? indent : -1;
  let maxLeadingIndent = 0;
  const valueStart = state.position;
  let valueEnd = state.position;
  while (state.input.charCodeAt(state.position) !== 0) {
    const linePosition = state.position;
    let column = 0;
    while (state.input.charCodeAt(linePosition + column) === 32) column++;
    const first = state.input.charCodeAt(linePosition + column);
    if (first === 0) {
      if (contentIndent >= 0) {
        if (column > contentIndent) valueEnd = linePosition + column;
      } else if (column > 0) valueEnd = linePosition + column;
      break;
    }
    if (testDocumentBoundary(state)) break;
    if (!detectedIndent && contentIndent === -1 && isEol(first)) maxLeadingIndent = Math.max(maxLeadingIndent, column);
    if (!detectedIndent && contentIndent === -1 && !isEol(first)) {
      if (first === 9 && column < parentIndent) {
        state.position = linePosition + column;
        throwError(state, "tab characters must not be used in indentation");
      }
      if (column < maxLeadingIndent) {
        state.position = linePosition + column;
        throwError(state, "bad indentation of a mapping entry");
      }
    }
    if (contentIndent === -1 && first !== 0 && !isEol(first) && column < parentIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    if (!detectedIndent && first !== 0 && !isEol(first) && contentIndent === -1) contentIndent = column;
    const requiredIndent = contentIndent === -1 ? parentIndent + 1 : contentIndent;
    if (first !== 0 && !isEol(first) && column < requiredIndent) {
      state.lineIndent = column;
      state.position = linePosition + column;
      break;
    }
    skipUntilLineEnd(state);
    valueEnd = state.position;
    if (isEol(state.input.charCodeAt(state.position))) {
      consumeLineBreak(state);
      valueEnd = state.position;
    }
  }
  checkPrintable(state, valueStart, valueEnd);
  addScalarEvent(state, valueStart, valueEnd, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, style, chomping, contentIndent);
  return true;
}
function canStartPlainScalar(state, nodeContext) {
  const ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  if (ch === 0 || isWsOrEol(ch) || ch === 35 || ch === 38 || ch === 42 || ch === 33 || ch === 124 || ch === 62 || ch === 39 || ch === 34 || ch === 37 || ch === 64 || ch === 96 || inFlow && isFlowIndicator(ch)) return false;
  if (ch === 63 || ch === 45) {
    const following = state.input.charCodeAt(state.position + 1);
    if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) return false;
  }
  return true;
}
function readPlainScalar(state, nodeIndent, nodeContext, props) {
  if (!canStartPlainScalar(state, nodeContext)) return false;
  const start = state.position;
  let end = state.position;
  let ch = state.input.charCodeAt(state.position);
  const inFlow = nodeContext === CONTEXT_FLOW_IN;
  let multiline = false;
  while (ch !== 0) {
    if (testDocumentBoundary(state)) break;
    if (ch === 58) {
      const following = state.input.charCodeAt(state.position + 1);
      if (isWsOrEolOrEnd(following) || inFlow && isFlowIndicator(following)) break;
    } else if (ch === 35) {
      if (isWsOrEol(state.input.charCodeAt(state.position - 1))) break;
    } else if (inFlow && isFlowIndicator(ch)) break;
    else if (isEol(ch)) {
      const savedPosition = state.position;
      const savedLine = state.line;
      const savedLineStart = state.lineStart;
      const savedLineIndent = state.lineIndent;
      skipSeparationSpace(state, false);
      if (state.lineIndent >= nodeIndent) {
        multiline = true;
        ch = state.input.charCodeAt(state.position);
        continue;
      }
      state.position = savedPosition;
      state.line = savedLine;
      state.lineStart = savedLineStart;
      state.lineIndent = savedLineIndent;
      break;
    }
    if (!isWhiteSpace(ch)) end = state.position + 1;
    ch = state.input.charCodeAt(++state.position);
  }
  if (end === start) return false;
  checkPrintable(state, start, end);
  addScalarEvent(state, start, end, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN, CHOMPING_MODE.CLIP, -1, !multiline);
  return true;
}
function skipFlowSeparationSpace(state, nodeIndent) {
  const startLine = state.line;
  skipSeparationSpace(state, true);
  if (state.line > startLine && state.lineIndent < nodeIndent || state.firstTabInLine !== -1 && state.lineIndent < nodeIndent) throwError(state, "deficient indentation");
}
function readFlowCollection(state, nodeIndent, props) {
  const ch = state.input.charCodeAt(state.position);
  const isMapping = ch === 123;
  const start = state.position;
  let readNext = true;
  if (ch !== 91 && ch !== 123) return false;
  const terminator = isMapping ? 125 : 93;
  if (isMapping) addMappingEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  else addSequenceEvent(state, start, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.FLOW);
  state.position++;
  while (state.input.charCodeAt(state.position) !== 0) {
    skipFlowSeparationSpace(state, nodeIndent);
    let ch2 = state.input.charCodeAt(state.position);
    if (ch2 === terminator) {
      state.position++;
      addPopEvent(state);
      return true;
    } else if (!readNext) throwError(state, "missed comma between flow collection entries");
    else if (ch2 === 44) throwError(state, "expected the node content, but found ','");
    let isPair = false;
    let isExplicitPair = false;
    if (ch2 === 63 && isWsOrEol(state.input.charCodeAt(state.position + 1))) {
      isPair = isExplicitPair = true;
      state.position += 1;
      skipFlowSeparationSpace(state, nodeIndent);
    }
    const entryLine = state.line;
    const entryStart = snapshotState(state);
    const keyWasRead = parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true);
    skipFlowSeparationSpace(state, nodeIndent);
    ch2 = state.input.charCodeAt(state.position);
    if ((isMapping || isExplicitPair || state.line === entryLine) && ch2 === 58) {
      isPair = true;
      state.position++;
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) {
        insertFlowPairMappingEvent(state, entryStart);
        if (!keyWasRead) addEmptyScalarEvent(state);
      } else if (!keyWasRead) addEmptyScalarEvent(state);
      if (!parseNode(state, nodeIndent, CONTEXT_FLOW_IN, false, true)) addEmptyScalarEvent(state);
      skipFlowSeparationSpace(state, nodeIndent);
      if (!isMapping) addPopEvent(state);
    } else if (isMapping && isPair) {
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
    } else if (isMapping) addEmptyScalarEvent(state);
    else if (isPair) {
      insertFlowPairMappingEvent(state, entryStart);
      if (!keyWasRead) addEmptyScalarEvent(state);
      addEmptyScalarEvent(state);
      addPopEvent(state);
    }
    ch2 = state.input.charCodeAt(state.position);
    if (ch2 === 44) {
      readNext = true;
      state.position++;
    } else readNext = false;
  }
  throwError(state, "unexpected end of the stream within a flow collection");
}
function readBlockSequence(state, nodeIndent, props) {
  if (state.firstTabInLine !== -1 || state.input.charCodeAt(state.position) !== 45 || !isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) return false;
  addSequenceEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
  while (state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) {
    if (state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const entryLine = state.line;
    state.position++;
    const hadBreak = skipSeparationSpace(state, true) > 0;
    if (state.firstTabInLine !== -1 && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
    if (hadBreak && state.lineIndent <= nodeIndent) addEmptyScalarEvent(state);
    else parseNode(state, nodeIndent, CONTEXT_BLOCK_IN, false, true);
    skipSeparationSpace(state, true);
    if (state.lineIndent < nodeIndent || state.position >= state.length) break;
    if (state.lineIndent > nodeIndent) throwError(state, "bad indentation of a sequence entry");
    if (state.line === entryLine && state.input.charCodeAt(state.position) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 1))) throwError(state, "bad indentation of a sequence entry");
  }
  addPopEvent(state);
  return true;
}
function readBlockMapping(state, nodeIndent, flowIndent, props) {
  let atExplicitKey = false;
  let detected = false;
  let mappingOpened = false;
  let pendingExplicitKey = false;
  if (state.firstTabInLine !== -1) return false;
  let ch = state.input.charCodeAt(state.position);
  while (ch !== 0) {
    if (!atExplicitKey && state.firstTabInLine !== -1) {
      state.position = state.firstTabInLine;
      throwError(state, "tab characters must not be used in indentation");
    }
    const following = state.input.charCodeAt(state.position + 1);
    const entryLine = state.line;
    if ((ch === 63 || ch === 58) && isWsOrEolOrEnd(following)) {
      if (!mappingOpened) {
        addMappingEvent(state, state.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
        mappingOpened = true;
      }
      if (ch === 63) {
        if (atExplicitKey) addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = true;
      } else if (atExplicitKey) atExplicitKey = false;
      else {
        addEmptyScalarEvent(state);
        detected = true;
        atExplicitKey = false;
      }
      state.position += 1;
      pendingExplicitKey = true;
    } else {
      if (atExplicitKey) {
        addEmptyScalarEvent(state);
        atExplicitKey = false;
      }
      const beforeKey = snapshotState(state);
      if (!parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true)) break;
      if (state.line === entryLine) {
        ch = state.input.charCodeAt(state.position);
        while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
        if (ch === 58) {
          ch = state.input.charCodeAt(++state.position);
          if (!isWsOrEolOrEnd(ch)) throwError(state, "a whitespace character is expected after the key-value separator within a block mapping");
          if (!mappingOpened) {
            restoreState(state, beforeKey);
            addMappingEvent(state, beforeKey.position, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, COLLECTION_STYLE.BLOCK);
            mappingOpened = true;
            parseNode(state, flowIndent, CONTEXT_FLOW_OUT, false, true);
            ch = state.input.charCodeAt(state.position);
            while (isWhiteSpace(ch)) ch = state.input.charCodeAt(++state.position);
            state.position++;
          }
          detected = true;
          atExplicitKey = false;
          pendingExplicitKey = false;
        } else if (detected) throwError(state, "expected ':' after a mapping key");
        else {
          if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
            restoreState(state, beforeKey);
            return false;
          }
          return true;
        }
      } else if (detected) throwError(state, "can not read a block mapping entry; a multiline key may not be an implicit key");
      else {
        if (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1) {
          restoreState(state, beforeKey);
          return false;
        }
        return true;
      }
    }
    if (parseNode(state, nodeIndent, CONTEXT_BLOCK_OUT, true, pendingExplicitKey)) pendingExplicitKey = false;
    if (!atExplicitKey) {
      if (pendingExplicitKey) {
        addEmptyScalarEvent(state);
        pendingExplicitKey = false;
      }
    }
    skipSeparationSpace(state, true);
    ch = state.input.charCodeAt(state.position);
    if ((state.line === entryLine || state.lineIndent > nodeIndent) && ch !== 0) throwError(state, "bad indentation of a mapping entry");
    else if (state.lineIndent < nodeIndent) break;
  }
  if (!detected) return false;
  if (atExplicitKey) addEmptyScalarEvent(state);
  if (mappingOpened) addPopEvent(state);
  return true;
}
function parseNode(state, parentIndent, nodeContext, allowToSeek, allowCompact, allowPropertyMapping = true) {
  if (state.depth >= state.maxDepth) throwError(state, `nesting exceeded maxDepth (${state.maxDepth})`);
  state.depth++;
  let indentStatus = 1;
  let atNewLine = false;
  let hasContent = false;
  let propertyStart = null;
  const props = emptyProperties();
  let allowBlockScalars = nodeContext === CONTEXT_BLOCK_OUT || nodeContext === CONTEXT_BLOCK_IN;
  let allowBlockCollections = allowBlockScalars;
  const allowBlockStyles = allowBlockScalars;
  if (allowToSeek && skipSeparationSpace(state, true)) {
    atNewLine = true;
    if (state.lineIndent > parentIndent) indentStatus = 1;
    else if (state.lineIndent === parentIndent) indentStatus = 0;
    else indentStatus = -1;
  }
  if (indentStatus === 1) while (true) {
    const ch = state.input.charCodeAt(state.position);
    const propertyState = snapshotState(state);
    if (atNewLine && indentStatus !== 1 && (ch === 33 || ch === 38)) break;
    if (atNewLine && allowBlockStyles && (props.tagStart !== NO_RANGE$1 || props.anchorStart !== NO_RANGE$1) && (ch === 33 || ch === 38)) {
      const fallbackState = snapshotState(state);
      const flowIndent = parentIndent + 1;
      if (readBlockMapping(state, state.position - state.lineStart, flowIndent, props) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) {
        state.depth--;
        return true;
      }
      restoreState(state, fallbackState);
    }
    if (atNewLine && (ch === 33 && props.tagStart !== NO_RANGE$1 || ch === 38 && props.anchorStart !== NO_RANGE$1)) break;
    if (!readTagProperty(state, props, nodeContext === CONTEXT_FLOW_IN) && !readAnchorProperty(state, props)) break;
    if (propertyStart === null) propertyStart = propertyState;
    if (skipSeparationSpace(state, true)) {
      atNewLine = true;
      allowBlockCollections = allowBlockStyles;
      if (state.lineIndent > parentIndent) indentStatus = 1;
      else if (state.lineIndent === parentIndent) indentStatus = 0;
      else indentStatus = -1;
    } else allowBlockCollections = false;
  }
  if (allowBlockCollections) allowBlockCollections = atNewLine || allowCompact;
  if (indentStatus === 1 || nodeContext === CONTEXT_BLOCK_OUT) {
    const flowIndent = nodeContext === CONTEXT_FLOW_IN || nodeContext === CONTEXT_FLOW_OUT ? parentIndent : parentIndent + 1;
    const blockIndent = state.position - state.lineStart;
    if (indentStatus === 1) if (allowBlockCollections && (readBlockSequence(state, blockIndent, props) || readBlockMapping(state, blockIndent, flowIndent, props)) || readFlowCollection(state, flowIndent, props)) hasContent = true;
    else {
      const ch = state.input.charCodeAt(state.position);
      if (propertyStart !== null && allowPropertyMapping && allowBlockStyles && !allowBlockCollections && ch !== 124 && ch !== 62) {
        const fallbackState = snapshotState(state);
        const propertyIndent = propertyStart.position - propertyStart.lineStart;
        restoreState(state, propertyStart);
        if (readBlockMapping(state, propertyIndent, flowIndent, emptyProperties()) && state.events[fallbackState.eventsLength]?.type === EVENT_ID.MAPPING) hasContent = true;
        else restoreState(state, fallbackState);
      }
      if (!hasContent && (allowBlockScalars && readBlockScalar(state, flowIndent, props) || readSingleQuotedScalar(state, flowIndent, props) || readDoubleQuotedScalar(state, flowIndent, props) || readAlias(state, props) || readPlainScalar(state, flowIndent, nodeContext, props))) hasContent = true;
    }
    else if (indentStatus === 0) hasContent = allowBlockCollections && readBlockSequence(state, blockIndent, props);
  }
  allowBlockScalars = allowBlockScalars && !hasContent;
  if (!hasContent && (props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1 || allowBlockScalars)) {
    addScalarEvent(state, NO_RANGE$1, NO_RANGE$1, props.anchorStart, props.anchorEnd, props.tagStart, props.tagEnd, SCALAR_STYLE.PLAIN);
    hasContent = true;
  }
  state.depth--;
  return hasContent || props.anchorStart !== NO_RANGE$1 || props.tagStart !== NO_RANGE$1;
}
function readDirective(state) {
  if (state.lineIndent > 0 || state.input.charCodeAt(state.position) !== 37) return false;
  state.position++;
  const nameStart = state.position;
  while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
  const name = state.input.slice(nameStart, state.position);
  const args = [];
  if (name.length === 0) throwError(state, "directive name must not be less than one character in length");
  while (state.input.charCodeAt(state.position) !== 0 && !isEol(state.input.charCodeAt(state.position))) {
    while (isWhiteSpace(state.input.charCodeAt(state.position))) state.position++;
    if (state.input.charCodeAt(state.position) === 35 || isEol(state.input.charCodeAt(state.position)) || state.input.charCodeAt(state.position) === 0) break;
    const start = state.position;
    while (state.input.charCodeAt(state.position) !== 0 && !isWsOrEol(state.input.charCodeAt(state.position))) state.position++;
    args.push(state.input.slice(start, state.position));
  }
  if (isEol(state.input.charCodeAt(state.position))) consumeLineBreak(state);
  if (name === "YAML") {
    if (state.directives.some((directive) => directive.kind === "yaml")) throwError(state, "duplication of %YAML directive");
    if (args.length !== 1) throwError(state, "YAML directive accepts exactly one argument");
    const match = /^([0-9]+)\.([0-9]+)$/.exec(args[0]);
    if (match === null) throwError(state, "ill-formed argument of the YAML directive");
    if (parseInt(match[1], 10) !== 1) throwError(state, "unacceptable YAML version of the document");
    state.directives.push({
      kind: "yaml",
      version: args[0]
    });
  } else if (name === "TAG") {
    if (args.length !== 2) throwError(state, "TAG directive accepts exactly two arguments");
    const [handle, prefix] = args;
    if (!PATTERN_TAG_HANDLE.test(handle)) throwError(state, "ill-formed tag handle (first argument) of the TAG directive");
    if (HAS_OWN.call(state.tagHandlers, handle)) throwError(state, `there is a previously declared suffix for "${handle}" tag handle`);
    if (!PATTERN_TAG_PREFIX.test(prefix)) throwError(state, "ill-formed tag prefix (second argument) of the TAG directive");
    state.tagHandlers[handle] = prefix;
    state.directives.push({
      kind: "tag",
      handle,
      prefix
    });
  }
  return true;
}
function readDocument(state) {
  state.directives = [];
  state.tagHandlers = /* @__PURE__ */ Object.create(null);
  let hasDirectives = false;
  skipSeparationSpace(state, true);
  while (readDirective(state)) {
    hasDirectives = true;
    skipSeparationSpace(state, true);
  }
  let explicitStart = false;
  let explicitEnd = false;
  let allowCompact = true;
  if (state.lineIndent === 0 && state.input.charCodeAt(state.position) === 45 && state.input.charCodeAt(state.position + 1) === 45 && state.input.charCodeAt(state.position + 2) === 45 && isWsOrEolOrEnd(state.input.charCodeAt(state.position + 3))) {
    explicitStart = true;
    const markerLine = state.line;
    state.position += 3;
    skipSeparationSpace(state, true);
    allowCompact = state.line > markerLine;
  } else if (hasDirectives) throwError(state, "directives end mark is expected");
  const documentEventIndex = state.events.length;
  if (!explicitStart && state.position === state.lineStart && state.input.charCodeAt(state.position) === 46 && testDocumentSeparator(state)) {
    state.position += 3;
    skipSeparationSpace(state, true);
    return;
  }
  addDocumentEvent(state, explicitStart, false);
  if (!parseNode(state, state.lineIndent - 1, CONTEXT_BLOCK_OUT, false, allowCompact, allowCompact)) addEmptyScalarEvent(state);
  skipSeparationSpace(state, true);
  if (state.position === state.lineStart && testDocumentSeparator(state)) {
    explicitEnd = state.input.charCodeAt(state.position) === 46;
    if (explicitEnd) {
      const markerLine = state.line;
      state.position += 3;
      skipSeparationSpace(state, true);
      if (state.line === markerLine && state.position < state.length) throwError(state, "end of the stream or a document separator is expected");
    }
  }
  const documentEvent = state.events[documentEventIndex];
  if (documentEvent?.type === EVENT_ID.DOCUMENT) documentEvent.explicitEnd = explicitEnd;
  addPopEvent(state);
  if (!explicitEnd && state.position < state.length && !testDocumentBoundary(state)) throwError(state, "end of the stream or a document separator is expected");
}
function parseEvents(input, options) {
  const length = input.length;
  const state = {
    ...DEFAULT_PARSER_OPTIONS,
    ...options,
    input: `${input}\0`,
    length,
    position: 0,
    line: 0,
    lineStart: 0,
    lineIndent: 0,
    firstTabInLine: -1,
    depth: 0,
    directives: [],
    tagHandlers: /* @__PURE__ */ Object.create(null),
    events: []
  };
  const nullpos = input.indexOf("\0");
  if (nullpos !== -1) YAMLException.throwAt(input, nullpos, "null byte is not allowed in input", state.filename);
  while (state.position < state.length) {
    skipByteOrderMark(state);
    skipSeparationSpace(state, true);
    if (state.position >= state.length) break;
    const documentStart = state.position;
    readDocument(state);
    if (state.position === documentStart)
      throwError(state, "can not read a document");
  }
  return state.events;
}
var DEFAULT_LOAD_OPTIONS = {
  ...DEFAULT_PARSER_OPTIONS,
  ...DEFAULT_CONSTRUCTOR_OPTIONS
};
function loadDocuments(input, options = {}) {
  const opts = {
    ...DEFAULT_LOAD_OPTIONS,
    ...options
  };
  const source = String(input);
  const PARSER_OPT_KEYS = Object.keys(DEFAULT_PARSER_OPTIONS);
  const CONSTRUCTOR_OPT_KEYS = Object.keys(DEFAULT_CONSTRUCTOR_OPTIONS);
  return constructFromEvents(parseEvents(source, pick(opts, PARSER_OPT_KEYS)), {
    ...pick(opts, CONSTRUCTOR_OPT_KEYS),
    source
  });
}
function load(input, options) {
  const documents = loadDocuments(input, options);
  if (documents.length === 0) throw new YAMLException("expected a document, but the input is empty");
  if (documents.length === 1) return documents[0];
  throw new YAMLException("expected a single document in the stream, but found more");
}
function hasBit(mask, bit) {
  return (mask & 1 << bit) !== 0;
}
var DEFAULT_SCALAR_STYLE_RULES = {
  applyQuoteFlowKeysOption,
  doubleQuoteForInvisibles,
  doubleQuoteWhitespaceOnly,
  applyForceQuotesOption,
  tryLongOrMultilineAsBlock,
  quoteInvalidPlain,
  fallbackToDoubleQuoted
};
function _preferredQuotedStyle(layout) {
  if (layout.presenterOptions.quoteStyle === "single" && hasBit(layout.allowedStylesMask, SCALAR_STYLE.SINGLE_QUOTED)) return SCALAR_STYLE.SINGLE_QUOTED;
  return SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyQuoteFlowKeysOption(layout) {
  if (!layout.presenterOptions.quoteFlowKeys) return;
  if (!layout.isKey || !layout.flowOnly || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteForInvisibles(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /[\t\x7F-\xA0\u2028\u2029\uFEFF\uFFFE\uFFFF]/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function doubleQuoteWhitespaceOnly(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && /^\s+$/.test(layout.node.value)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
function applyForceQuotesOption(layout) {
  if (!layout.presenterOptions.forceQuotes) return;
  if (layout.isKey || layout.style !== SCALAR_STYLE.PLAIN) return;
  layout.style = layout.node.value.includes("\n") ? SCALAR_STYLE.DOUBLE_QUOTED : _preferredQuotedStyle(layout);
}
function tryLongOrMultilineAsBlock(layout) {
  if (layout.style !== SCALAR_STYLE.PLAIN || layout.isKey) return;
  const value = layout.node.value;
  const multiline = value.indexOf("\n") !== -1;
  if (!hasBit(layout.allowedStylesMask, SCALAR_STYLE.LITERAL_BLOCK)) {
    if (multiline) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
    return;
  }
  const w = layout.presenterOptions.lineWidth;
  if (w === -1) {
    if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
    return;
  }
  const availableWidth = Math.max(Math.min(w, 40), w - layout.shiftOfContent);
  let position = 0;
  let shouldFold = false;
  while (position <= value.length) {
    let lineEnd = value.length;
    const nextLineBreak = value.indexOf("\n", position);
    if (nextLineBreak !== -1) lineEnd = nextLineBreak;
    const line = value.slice(position, lineEnd);
    if (line.length > availableWidth && line[0] !== " " && / [^ \t]/.test(line)) shouldFold = true;
    if (nextLineBreak === -1) break;
    position = nextLineBreak + 1;
  }
  if (shouldFold) layout.style = SCALAR_STYLE.FOLDED_BLOCK;
  else if (multiline) layout.style = SCALAR_STYLE.LITERAL_BLOCK;
}
function quoteInvalidPlain(layout) {
  if (layout.style === SCALAR_STYLE.PLAIN && !hasBit(layout.allowedStylesMask, SCALAR_STYLE.PLAIN)) layout.style = _preferredQuotedStyle(layout);
}
function fallbackToDoubleQuoted(layout) {
  if (!hasBit(layout.allowedStylesMask, layout.style)) layout.style = SCALAR_STYLE.DOUBLE_QUOTED;
}
var SRC_C_PRINTABLE = "[\\x09\\x0A\\x0D\\x20-\\x7E\\x85\\xA0-\\uD7FF\\uE000-\\uFFFD\\u{10000}-\\u{10FFFF}]";
var SRC_B_CHAR = "[\\n\\r]";
var SRC_C_BYTE_ORDER_MARK = "\\uFEFF";
var SRC_S_WHITE = "[ \\t]";
var SRC_NB_CHAR = `(?:(?!(?:${SRC_B_CHAR}|${SRC_C_BYTE_ORDER_MARK}))${SRC_C_PRINTABLE})`;
var SRC_NS_CHAR = `(?:(?!${SRC_S_WHITE})${SRC_NB_CHAR})`;
var SRC_NB_JSON = "[\\x09\\x20-\\uD7FF\\uE000-\\uFFFF\\u{10000}-\\u{10FFFF}]";
var SRC_C_INDICATOR = "[-?:,\\[\\]{}#&*!|>'\"%@`]";
var SRC_C_FLOW_INDICATOR = "[,\\[\\]{}]";
var SRC_NS_PLAIN_SAFE_FLOW_OUT = SRC_NS_CHAR;
var SRC_NS_PLAIN_SAFE_FLOW_IN = `(?:(?!${SRC_C_FLOW_INDICATOR})${SRC_NS_CHAR})`;
var SRC_NS_PLAIN_FIRST_FLOW_OUT = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))`;
var SRC_NS_PLAIN_FIRST_FLOW_IN = `(?:(?:(?!${SRC_C_INDICATOR})${SRC_NS_CHAR})|[?:-](?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))`;
var SRC_NS_PLAIN_CHAR_FLOW_OUT = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_OUT})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_OUT}))#*`;
var SRC_NS_PLAIN_CHAR_FLOW_IN = `(?:(?:(?![:#])${SRC_NS_PLAIN_SAFE_FLOW_IN})|:(?=${SRC_NS_PLAIN_SAFE_FLOW_IN}))#*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_OUT})*`;
var SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN = `(?:${SRC_S_WHITE}*${SRC_NS_PLAIN_CHAR_FLOW_IN})*`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_OUT = `${SRC_NS_PLAIN_FIRST_FLOW_OUT}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_NS_PLAIN_ONE_LINE_FLOW_IN = `${SRC_NS_PLAIN_FIRST_FLOW_IN}#*${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_OUT;
var SRC_NS_PLAIN_ONE_LINE_FLOW_KEY = SRC_NS_PLAIN_ONE_LINE_FLOW_IN;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_OUT}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_OUT}`;
var SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN = `\\n+${SRC_NS_PLAIN_CHAR_FLOW_IN}${SRC_NB_NS_PLAIN_IN_LINE_FLOW_IN}`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT = `${SRC_NS_PLAIN_ONE_LINE_FLOW_OUT}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_OUT})*`;
var SRC_NS_PLAIN_MULTI_LINE_FLOW_IN = `${SRC_NS_PLAIN_ONE_LINE_FLOW_IN}(?:${SRC_S_NS_PLAIN_NEXT_LINE_FLOW_IN})*`;
var NS_PLAIN_FLOW_OUT = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_OUT})$`, "u");
var NS_PLAIN_FLOW_IN = new RegExp(`^(?:${SRC_NS_PLAIN_MULTI_LINE_FLOW_IN})$`, "u");
var NS_PLAIN_BLOCK_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_BLOCK_KEY})$`, "u");
var NS_PLAIN_FLOW_KEY = new RegExp(`^(?:${SRC_NS_PLAIN_ONE_LINE_FLOW_KEY})$`, "u");
var NB_SINGLE_ONE_LINE = new RegExp(`^(?:${SRC_NB_JSON})*$`, "u");
var NB_SINGLE_MULTI_LINE = new RegExp(`^(?:${SRC_NB_JSON}|\\n)*$`, "u");
var BLOCK_SCALAR_CONTENT = new RegExp(`^(?:${SRC_NB_CHAR}|\\n)*$`, "u");
var DEFAULT_PRESENTER_OPTIONS = {
  indent: 2,
  seqNoIndent: false,
  seqInlineFirst: true,
  lineWidth: 80,
  flowBracketPadding: false,
  flowSkipCommaSpace: false,
  flowSkipColonSpace: false,
  quoteFlowKeys: false,
  quoteStyle: "single",
  forceQuotes: false,
  scalarStyleRules: Object.keys(DEFAULT_SCALAR_STYLE_RULES).map((name) => Reflect.get(DEFAULT_SCALAR_STYLE_RULES, name)),
  tagBeforeAnchor: false
};
var DEFAULT_DUMP_OPTIONS = {
  ...DEFAULT_PRESENTER_OPTIONS,
  schema: DUMP_SCHEMA,
  skipInvalid: false,
  noRefs: false,
  flowLevel: -1,
  sortKeys: false,
  transform: () => {
  }
};
var EVENT_DOCUMENT = EVENT_ID.DOCUMENT;
var EVENT_SEQUENCE = EVENT_ID.SEQUENCE;
var EVENT_MAPPING = EVENT_ID.MAPPING;
var EVENT_SCALAR = EVENT_ID.SCALAR;
var EVENT_ALIAS = EVENT_ID.ALIAS;
var EVENT_POP = EVENT_ID.POP;
var SCALAR_STYLE_PLAIN = SCALAR_STYLE.PLAIN;
var SCALAR_STYLE_SINGLE_QUOTED = SCALAR_STYLE.SINGLE_QUOTED;
var SCALAR_STYLE_DOUBLE_QUOTED = SCALAR_STYLE.DOUBLE_QUOTED;
var SCALAR_STYLE_LITERAL_BLOCK = SCALAR_STYLE.LITERAL_BLOCK;
var SCALAR_STYLE_FOLDED_BLOCK = SCALAR_STYLE.FOLDED_BLOCK;
var COLLECTION_STYLE_BLOCK = COLLECTION_STYLE.BLOCK;
var COLLECTION_STYLE_FLOW = COLLECTION_STYLE.FLOW;
var CHOMPING_CLIP = CHOMPING_MODE.CLIP;
var CHOMPING_STRIP = CHOMPING_MODE.STRIP;
var CHOMPING_KEEP = CHOMPING_MODE.KEEP;

// src/runtime/tools/workspace-tools.ts
import { execFile } from "node:child_process";
import { existsSync as existsSync2, lstatSync, mkdirSync as mkdirSync2, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join as join2, relative as relative2, resolve as resolve2 } from "node:path";

// src/runtime/tools/paths.ts
import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

// src/runtime/tools/types.ts
var ToolError = class extends Error {
};

// src/runtime/tools/paths.ts
function resolveInWorkspace(root, input, label = "path") {
  if (typeof input !== "string" || !input.trim()) throw new ToolError(`${label} is required`);
  const candidate = isAbsolute(input) ? input : resolve(root, input);
  const full = resolve(candidate);
  assertInside(root, full, input);
  const real = realPathIfExists(full);
  if (real) assertInside(realPathIfExists(root) ?? root, real, input);
  return full;
}
function assertInside(root, full, shown) {
  const rel = relative(root, full);
  if (rel === "") return;
  if (rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    throw new ToolError(`"${shown}" is outside the workspace`);
  }
}
function realPathIfExists(p) {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}

// src/runtime/tools/workspace-tools.ts
var MAX_READ_BYTES = 2e5;
var MAX_WRITE_BYTES = 2e6;
var MAX_LIST_ENTRIES = 500;
var MAX_MATCHES = 100;
var MAX_COMMAND_OUTPUT = 3e4;
var DEFAULT_COMMAND_TIMEOUT_MS = 3e5;
var SKIP_DIRS = /* @__PURE__ */ new Set([".git", "node_modules", ".next", "dist", "build", ".venv", "__pycache__", ".turbo"]);
function str(input, key, required = true) {
  const v = input[key];
  if (typeof v === "string" && v.length) return v;
  if (required) throw new ToolError(`"${key}" is required`);
  return "";
}
function truncate(s, max, what) {
  return s.length > max ? `${s.slice(0, max)}
\u2026 [${what} truncated at ${max} characters]` : s;
}
var readFile = {
  name: "read_file",
  description: "Read a file from the workspace. Returns its content with 1-based line numbers.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      offset: { type: "integer", description: "1-based line to start at (optional)." },
      limit: { type: "integer", description: "How many lines to read (optional)." }
    },
    required: ["path"]
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    if (!existsSync2(file)) throw new ToolError(`no such file: ${str(input, "path")}`);
    if (statSync(file).isDirectory()) throw new ToolError(`"${str(input, "path")}" is a directory; use list_files`);
    const raw = readFileSync(file, "utf8");
    const lines = raw.split("\n");
    const offset = Math.max(1, Number(input.offset ?? 1));
    const limit = Math.max(1, Number(input.limit ?? lines.length));
    const slice = lines.slice(offset - 1, offset - 1 + limit);
    const numbered = slice.map((l, i) => `${offset + i}	${l}`).join("\n");
    return truncate(numbered, MAX_READ_BYTES, "file");
  }
};
var writeFile = {
  name: "write_file",
  description: "Create a file or replace its whole content. Parent directories are created as needed.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Path relative to the workspace root." },
      content: { type: "string", description: "The complete new file content." }
    },
    required: ["path", "content"]
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    const content = typeof input.content === "string" ? input.content : "";
    if (content.length > MAX_WRITE_BYTES) throw new ToolError(`content is larger than ${MAX_WRITE_BYTES} bytes`);
    if (existsSync2(file) && statSync(file).isDirectory()) throw new ToolError(`"${str(input, "path")}" is a directory`);
    mkdirSync2(resolve2(file, ".."), { recursive: true });
    writeFileSync(file, content);
    return `wrote ${content.length} characters to ${relative2(ctx.root, file)}`;
  }
};
var editFile = {
  name: "edit_file",
  description: "Replace an exact string in a file. The old string must appear exactly once unless replace_all is true \u2014 read the file first.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string" },
      old_string: { type: "string", description: "Exact text to replace, including indentation." },
      new_string: { type: "string", description: "Replacement text." },
      replace_all: { type: "boolean", description: "Replace every occurrence (default false)." }
    },
    required: ["path", "old_string", "new_string"]
  },
  async execute(input, ctx) {
    const file = resolveInWorkspace(ctx.root, input.path);
    if (!existsSync2(file)) throw new ToolError(`no such file: ${str(input, "path")}`);
    const oldString = str(input, "old_string");
    const newString = typeof input.new_string === "string" ? input.new_string : "";
    const raw = readFileSync(file, "utf8");
    const count = raw.split(oldString).length - 1;
    if (count === 0) throw new ToolError("old_string was not found in the file");
    if (count > 1 && input.replace_all !== true) {
      throw new ToolError(`old_string appears ${count} times; pass replace_all or include more context`);
    }
    const parts = raw.split(oldString);
    const updated = input.replace_all === true ? parts.join(newString) : [parts[0], parts.slice(1).join(oldString)].join(newString);
    writeFileSync(file, updated);
    return `edited ${relative2(ctx.root, file)} (${input.replace_all === true ? count : 1} replacement${count > 1 && input.replace_all === true ? "s" : ""})`;
  }
};
function walk(root, dir, depth, out) {
  if (out.length >= MAX_LIST_ENTRIES || depth < 0) return;
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= MAX_LIST_ENTRIES) return;
    if (SKIP_DIRS.has(entry) || entry.startsWith(".DS_Store")) continue;
    const full = join2(dir, entry);
    let isDir = false;
    try {
      const st = lstatSync(full);
      if (st.isSymbolicLink()) continue;
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    out.push(relative2(root, full) + (isDir ? "/" : ""));
    if (isDir) walk(root, full, depth - 1, out);
  }
}
var listFiles = {
  name: "list_files",
  description: "List files and directories in the workspace. Skips .git, node_modules and build output.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Directory to list, relative to the workspace root (default: the root)." },
      depth: { type: "integer", description: "How deep to recurse (default 2)." }
    }
  },
  async execute(input, ctx) {
    const dir = input.path ? resolveInWorkspace(ctx.root, input.path) : ctx.root;
    if (!existsSync2(dir)) throw new ToolError(`no such directory: ${String(input.path)}`);
    const out = [];
    walk(ctx.root, dir, Math.max(0, Number(input.depth ?? 2) - 1), out);
    if (!out.length) return "(empty)";
    const capped = out.length >= MAX_LIST_ENTRIES ? `
\u2026 [listing truncated at ${MAX_LIST_ENTRIES} entries]` : "";
    return out.join("\n") + capped;
  }
};
var searchFiles = {
  name: "search_files",
  description: "Search file contents with a regular expression. Returns path:line:text for each match.",
  mutates: false,
  inputSchema: {
    type: "object",
    properties: {
      pattern: { type: "string", description: "JavaScript regular expression." },
      path: { type: "string", description: "Directory to search in (default: the workspace root)." },
      extension: { type: "string", description: 'Only search files with this extension, e.g. "ts" (optional).' }
    },
    required: ["pattern"]
  },
  async execute(input, ctx) {
    const dir = input.path ? resolveInWorkspace(ctx.root, input.path) : ctx.root;
    let re;
    try {
      re = new RegExp(str(input, "pattern"));
    } catch (e) {
      throw new ToolError(`invalid regular expression: ${e.message}`);
    }
    const ext = typeof input.extension === "string" ? input.extension.replace(/^\./, "") : null;
    const files = [];
    walk(ctx.root, dir, 12, files);
    const matches = [];
    for (const rel of files) {
      if (rel.endsWith("/")) continue;
      if (ext && !rel.endsWith(`.${ext}`)) continue;
      if (matches.length >= MAX_MATCHES) break;
      let content;
      try {
        const full = join2(ctx.root, rel);
        if (statSync(full).size > MAX_READ_BYTES) continue;
        content = readFileSync(full, "utf8");
      } catch {
        continue;
      }
      content.split("\n").forEach((line, i) => {
        if (matches.length >= MAX_MATCHES || !re.test(line)) return;
        matches.push(`${rel}:${i + 1}:${line.trim().slice(0, 200)}`);
      });
    }
    return matches.length ? matches.join("\n") : "(no matches)";
  }
};
var runCommandTool = {
  name: "run_command",
  description: "Run a command in the workspace. Pass argv as an array (no shell string). Returns the exit code with stdout and stderr.",
  mutates: true,
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "array",
        items: { type: "string" },
        description: 'Program and arguments, e.g. ["npm", "test"].'
      },
      cwd: { type: "string", description: "Directory to run in, relative to the workspace root (optional)." },
      timeout_ms: { type: "integer", description: "Timeout in milliseconds (default 300000)." }
    },
    required: ["command"]
  },
  async execute(input, ctx) {
    const argv = Array.isArray(input.command) ? input.command.map(String).filter(Boolean) : [];
    if (!argv.length) throw new ToolError("command must be a non-empty array of strings");
    const cwd = input.cwd ? resolveInWorkspace(ctx.root, input.cwd) : ctx.root;
    const timeout = Math.min(Math.max(Number(input.timeout_ms ?? DEFAULT_COMMAND_TIMEOUT_MS), 1e3), 6e5);
    const [file, ...args] = argv;
    return new Promise((resolvePromise, reject) => {
      execFile(file, args, { cwd, timeout, maxBuffer: 1e7, shell: false }, (error, stdout, stderr) => {
        const err = error;
        if (err?.killed) {
          reject(new ToolError(`command timed out after ${timeout}ms`));
          return;
        }
        if (err && typeof err.code !== "number") {
          reject(new ToolError(err.message));
          return;
        }
        const exitCode = typeof err?.code === "number" ? err.code : 0;
        const out = truncate(String(stdout).trim(), MAX_COMMAND_OUTPUT, "stdout");
        const errOut = truncate(String(stderr).trim(), MAX_COMMAND_OUTPUT, "stderr");
        resolvePromise(
          [`exit code: ${exitCode}`, out && `stdout:
${out}`, errOut && `stderr:
${errOut}`].filter(Boolean).join("\n\n")
        );
      });
    });
  }
};
var WORKSPACE_TOOLS = [readFile, writeFile, editFile, listFiles, searchFiles, runCommandTool];

// src/runtime/tools/registry.ts
var BY_NAME = new Map(WORKSPACE_TOOLS.map((t) => [t.name, t]));
function knownToolNames() {
  return [...BY_NAME.keys()].sort();
}
function isKnownTool(name) {
  return BY_NAME.has(name);
}
function getTool(name) {
  return BY_NAME.get(name);
}
function toolsFor(names, hasWorkspace) {
  if (!hasWorkspace) return [];
  const out = [];
  for (const name of names) {
    const tool = BY_NAME.get(name);
    if (tool) out.push(tool);
  }
  return out;
}

// src/agents/template.ts
var TemplateError = class extends Error {
};
var PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_-]*(?:\.[A-Za-z_][A-Za-z0-9_-]*)*)\s*\}\}/g;
function templatePaths(tpl) {
  const out = /* @__PURE__ */ new Set();
  for (const m of tpl.matchAll(PLACEHOLDER)) out.add(m[1]);
  return [...out];
}
function lookup(path, ctx) {
  let cur = ctx;
  for (const seg of path.split(".")) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[seg];
  }
  return cur;
}
function stringify(v) {
  if (typeof v === "string") return v;
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v, null, 2);
}
function renderTemplate(tpl, ctx) {
  const missing = [];
  const out = tpl.replace(PLACEHOLDER, (_m, path) => {
    const v = lookup(path, ctx);
    if (v === void 0) {
      missing.push(path);
      return "";
    }
    return stringify(v);
  });
  if (missing.length) throw new TemplateError(`unresolved template ${missing.length > 1 ? "values" : "value"}: ${missing.join(", ")}`);
  return out;
}

// node_modules/zod/v3/external.js
var external_exports = {};
__export(external_exports, {
  BRAND: () => BRAND,
  DIRTY: () => DIRTY,
  EMPTY_PATH: () => EMPTY_PATH,
  INVALID: () => INVALID,
  NEVER: () => NEVER,
  OK: () => OK,
  ParseStatus: () => ParseStatus,
  Schema: () => ZodType,
  ZodAny: () => ZodAny,
  ZodArray: () => ZodArray,
  ZodBigInt: () => ZodBigInt,
  ZodBoolean: () => ZodBoolean,
  ZodBranded: () => ZodBranded,
  ZodCatch: () => ZodCatch,
  ZodDate: () => ZodDate,
  ZodDefault: () => ZodDefault,
  ZodDiscriminatedUnion: () => ZodDiscriminatedUnion,
  ZodEffects: () => ZodEffects,
  ZodEnum: () => ZodEnum,
  ZodError: () => ZodError,
  ZodFirstPartyTypeKind: () => ZodFirstPartyTypeKind,
  ZodFunction: () => ZodFunction,
  ZodIntersection: () => ZodIntersection,
  ZodIssueCode: () => ZodIssueCode,
  ZodLazy: () => ZodLazy,
  ZodLiteral: () => ZodLiteral,
  ZodMap: () => ZodMap,
  ZodNaN: () => ZodNaN,
  ZodNativeEnum: () => ZodNativeEnum,
  ZodNever: () => ZodNever,
  ZodNull: () => ZodNull,
  ZodNullable: () => ZodNullable,
  ZodNumber: () => ZodNumber,
  ZodObject: () => ZodObject,
  ZodOptional: () => ZodOptional,
  ZodParsedType: () => ZodParsedType,
  ZodPipeline: () => ZodPipeline,
  ZodPromise: () => ZodPromise,
  ZodReadonly: () => ZodReadonly,
  ZodRecord: () => ZodRecord,
  ZodSchema: () => ZodType,
  ZodSet: () => ZodSet,
  ZodString: () => ZodString,
  ZodSymbol: () => ZodSymbol,
  ZodTransformer: () => ZodEffects,
  ZodTuple: () => ZodTuple,
  ZodType: () => ZodType,
  ZodUndefined: () => ZodUndefined,
  ZodUnion: () => ZodUnion,
  ZodUnknown: () => ZodUnknown,
  ZodVoid: () => ZodVoid,
  addIssueToContext: () => addIssueToContext,
  any: () => anyType,
  array: () => arrayType,
  bigint: () => bigIntType,
  boolean: () => booleanType,
  coerce: () => coerce,
  custom: () => custom,
  date: () => dateType,
  datetimeRegex: () => datetimeRegex,
  defaultErrorMap: () => en_default,
  discriminatedUnion: () => discriminatedUnionType,
  effect: () => effectsType,
  enum: () => enumType,
  function: () => functionType,
  getErrorMap: () => getErrorMap,
  getParsedType: () => getParsedType,
  instanceof: () => instanceOfType,
  intersection: () => intersectionType,
  isAborted: () => isAborted,
  isAsync: () => isAsync,
  isDirty: () => isDirty,
  isValid: () => isValid,
  late: () => late,
  lazy: () => lazyType,
  literal: () => literalType,
  makeIssue: () => makeIssue,
  map: () => mapType,
  nan: () => nanType,
  nativeEnum: () => nativeEnumType,
  never: () => neverType,
  null: () => nullType,
  nullable: () => nullableType,
  number: () => numberType,
  object: () => objectType,
  objectUtil: () => objectUtil,
  oboolean: () => oboolean,
  onumber: () => onumber,
  optional: () => optionalType,
  ostring: () => ostring,
  pipeline: () => pipelineType,
  preprocess: () => preprocessType,
  promise: () => promiseType,
  quotelessJson: () => quotelessJson,
  record: () => recordType,
  set: () => setType,
  setErrorMap: () => setErrorMap,
  strictObject: () => strictObjectType,
  string: () => stringType,
  symbol: () => symbolType,
  transformer: () => effectsType,
  tuple: () => tupleType,
  undefined: () => undefinedType,
  union: () => unionType,
  unknown: () => unknownType,
  util: () => util,
  void: () => voidType
});

// node_modules/zod/v3/helpers/util.js
var util;
(function(util2) {
  util2.assertEqual = (_) => {
  };
  function assertIs(_arg) {
  }
  util2.assertIs = assertIs;
  function assertNever(_x) {
    throw new Error();
  }
  util2.assertNever = assertNever;
  util2.arrayToEnum = (items) => {
    const obj = {};
    for (const item of items) {
      obj[item] = item;
    }
    return obj;
  };
  util2.getValidEnumValues = (obj) => {
    const validKeys = util2.objectKeys(obj).filter((k) => typeof obj[obj[k]] !== "number");
    const filtered = {};
    for (const k of validKeys) {
      filtered[k] = obj[k];
    }
    return util2.objectValues(filtered);
  };
  util2.objectValues = (obj) => {
    return util2.objectKeys(obj).map(function(e) {
      return obj[e];
    });
  };
  util2.objectKeys = typeof Object.keys === "function" ? (obj) => Object.keys(obj) : (object) => {
    const keys = [];
    for (const key in object) {
      if (Object.prototype.hasOwnProperty.call(object, key)) {
        keys.push(key);
      }
    }
    return keys;
  };
  util2.find = (arr, checker) => {
    for (const item of arr) {
      if (checker(item))
        return item;
    }
    return void 0;
  };
  util2.isInteger = typeof Number.isInteger === "function" ? (val) => Number.isInteger(val) : (val) => typeof val === "number" && Number.isFinite(val) && Math.floor(val) === val;
  function joinValues(array, separator = " | ") {
    return array.map((val) => typeof val === "string" ? `'${val}'` : val).join(separator);
  }
  util2.joinValues = joinValues;
  util2.jsonStringifyReplacer = (_, value) => {
    if (typeof value === "bigint") {
      return value.toString();
    }
    return value;
  };
})(util || (util = {}));
var objectUtil;
(function(objectUtil2) {
  objectUtil2.mergeShapes = (first, second) => {
    return {
      ...first,
      ...second
      // second overwrites first
    };
  };
})(objectUtil || (objectUtil = {}));
var ZodParsedType = util.arrayToEnum([
  "string",
  "nan",
  "number",
  "integer",
  "float",
  "boolean",
  "date",
  "bigint",
  "symbol",
  "function",
  "undefined",
  "null",
  "array",
  "object",
  "unknown",
  "promise",
  "void",
  "never",
  "map",
  "set"
]);
var getParsedType = (data) => {
  const t = typeof data;
  switch (t) {
    case "undefined":
      return ZodParsedType.undefined;
    case "string":
      return ZodParsedType.string;
    case "number":
      return Number.isNaN(data) ? ZodParsedType.nan : ZodParsedType.number;
    case "boolean":
      return ZodParsedType.boolean;
    case "function":
      return ZodParsedType.function;
    case "bigint":
      return ZodParsedType.bigint;
    case "symbol":
      return ZodParsedType.symbol;
    case "object":
      if (Array.isArray(data)) {
        return ZodParsedType.array;
      }
      if (data === null) {
        return ZodParsedType.null;
      }
      if (data.then && typeof data.then === "function" && data.catch && typeof data.catch === "function") {
        return ZodParsedType.promise;
      }
      if (typeof Map !== "undefined" && data instanceof Map) {
        return ZodParsedType.map;
      }
      if (typeof Set !== "undefined" && data instanceof Set) {
        return ZodParsedType.set;
      }
      if (typeof Date !== "undefined" && data instanceof Date) {
        return ZodParsedType.date;
      }
      return ZodParsedType.object;
    default:
      return ZodParsedType.unknown;
  }
};

// node_modules/zod/v3/ZodError.js
var ZodIssueCode = util.arrayToEnum([
  "invalid_type",
  "invalid_literal",
  "custom",
  "invalid_union",
  "invalid_union_discriminator",
  "invalid_enum_value",
  "unrecognized_keys",
  "invalid_arguments",
  "invalid_return_type",
  "invalid_date",
  "invalid_string",
  "too_small",
  "too_big",
  "invalid_intersection_types",
  "not_multiple_of",
  "not_finite"
]);
var quotelessJson = (obj) => {
  const json = JSON.stringify(obj, null, 2);
  return json.replace(/"([^"]+)":/g, "$1:");
};
var ZodError = class _ZodError extends Error {
  get errors() {
    return this.issues;
  }
  constructor(issues) {
    super();
    this.issues = [];
    this.addIssue = (sub) => {
      this.issues = [...this.issues, sub];
    };
    this.addIssues = (subs = []) => {
      this.issues = [...this.issues, ...subs];
    };
    const actualProto = new.target.prototype;
    if (Object.setPrototypeOf) {
      Object.setPrototypeOf(this, actualProto);
    } else {
      this.__proto__ = actualProto;
    }
    this.name = "ZodError";
    this.issues = issues;
  }
  format(_mapper) {
    const mapper = _mapper || function(issue) {
      return issue.message;
    };
    const fieldErrors = { _errors: [] };
    const processError = (error) => {
      for (const issue of error.issues) {
        if (issue.code === "invalid_union") {
          issue.unionErrors.map(processError);
        } else if (issue.code === "invalid_return_type") {
          processError(issue.returnTypeError);
        } else if (issue.code === "invalid_arguments") {
          processError(issue.argumentsError);
        } else if (issue.path.length === 0) {
          fieldErrors._errors.push(mapper(issue));
        } else {
          let curr = fieldErrors;
          let i = 0;
          while (i < issue.path.length) {
            const el = issue.path[i];
            const terminal = i === issue.path.length - 1;
            if (!terminal) {
              curr[el] = curr[el] || { _errors: [] };
            } else {
              curr[el] = curr[el] || { _errors: [] };
              curr[el]._errors.push(mapper(issue));
            }
            curr = curr[el];
            i++;
          }
        }
      }
    };
    processError(this);
    return fieldErrors;
  }
  static assert(value) {
    if (!(value instanceof _ZodError)) {
      throw new Error(`Not a ZodError: ${value}`);
    }
  }
  toString() {
    return this.message;
  }
  get message() {
    return JSON.stringify(this.issues, util.jsonStringifyReplacer, 2);
  }
  get isEmpty() {
    return this.issues.length === 0;
  }
  flatten(mapper = (issue) => issue.message) {
    const fieldErrors = {};
    const formErrors = [];
    for (const sub of this.issues) {
      if (sub.path.length > 0) {
        const firstEl = sub.path[0];
        fieldErrors[firstEl] = fieldErrors[firstEl] || [];
        fieldErrors[firstEl].push(mapper(sub));
      } else {
        formErrors.push(mapper(sub));
      }
    }
    return { formErrors, fieldErrors };
  }
  get formErrors() {
    return this.flatten();
  }
};
ZodError.create = (issues) => {
  const error = new ZodError(issues);
  return error;
};

// node_modules/zod/v3/locales/en.js
var errorMap = (issue, _ctx) => {
  let message;
  switch (issue.code) {
    case ZodIssueCode.invalid_type:
      if (issue.received === ZodParsedType.undefined) {
        message = "Required";
      } else {
        message = `Expected ${issue.expected}, received ${issue.received}`;
      }
      break;
    case ZodIssueCode.invalid_literal:
      message = `Invalid literal value, expected ${JSON.stringify(issue.expected, util.jsonStringifyReplacer)}`;
      break;
    case ZodIssueCode.unrecognized_keys:
      message = `Unrecognized key(s) in object: ${util.joinValues(issue.keys, ", ")}`;
      break;
    case ZodIssueCode.invalid_union:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_union_discriminator:
      message = `Invalid discriminator value. Expected ${util.joinValues(issue.options)}`;
      break;
    case ZodIssueCode.invalid_enum_value:
      message = `Invalid enum value. Expected ${util.joinValues(issue.options)}, received '${issue.received}'`;
      break;
    case ZodIssueCode.invalid_arguments:
      message = `Invalid function arguments`;
      break;
    case ZodIssueCode.invalid_return_type:
      message = `Invalid function return type`;
      break;
    case ZodIssueCode.invalid_date:
      message = `Invalid date`;
      break;
    case ZodIssueCode.invalid_string:
      if (typeof issue.validation === "object") {
        if ("includes" in issue.validation) {
          message = `Invalid input: must include "${issue.validation.includes}"`;
          if (typeof issue.validation.position === "number") {
            message = `${message} at one or more positions greater than or equal to ${issue.validation.position}`;
          }
        } else if ("startsWith" in issue.validation) {
          message = `Invalid input: must start with "${issue.validation.startsWith}"`;
        } else if ("endsWith" in issue.validation) {
          message = `Invalid input: must end with "${issue.validation.endsWith}"`;
        } else {
          util.assertNever(issue.validation);
        }
      } else if (issue.validation !== "regex") {
        message = `Invalid ${issue.validation}`;
      } else {
        message = "Invalid";
      }
      break;
    case ZodIssueCode.too_small:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `more than`} ${issue.minimum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? "exactly" : issue.inclusive ? `at least` : `over`} ${issue.minimum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "bigint")
        message = `Number must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${issue.minimum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly equal to ` : issue.inclusive ? `greater than or equal to ` : `greater than `}${new Date(Number(issue.minimum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.too_big:
      if (issue.type === "array")
        message = `Array must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `less than`} ${issue.maximum} element(s)`;
      else if (issue.type === "string")
        message = `String must contain ${issue.exact ? `exactly` : issue.inclusive ? `at most` : `under`} ${issue.maximum} character(s)`;
      else if (issue.type === "number")
        message = `Number must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "bigint")
        message = `BigInt must be ${issue.exact ? `exactly` : issue.inclusive ? `less than or equal to` : `less than`} ${issue.maximum}`;
      else if (issue.type === "date")
        message = `Date must be ${issue.exact ? `exactly` : issue.inclusive ? `smaller than or equal to` : `smaller than`} ${new Date(Number(issue.maximum))}`;
      else
        message = "Invalid input";
      break;
    case ZodIssueCode.custom:
      message = `Invalid input`;
      break;
    case ZodIssueCode.invalid_intersection_types:
      message = `Intersection results could not be merged`;
      break;
    case ZodIssueCode.not_multiple_of:
      message = `Number must be a multiple of ${issue.multipleOf}`;
      break;
    case ZodIssueCode.not_finite:
      message = "Number must be finite";
      break;
    default:
      message = _ctx.defaultError;
      util.assertNever(issue);
  }
  return { message };
};
var en_default = errorMap;

// node_modules/zod/v3/errors.js
var overrideErrorMap = en_default;
function setErrorMap(map) {
  overrideErrorMap = map;
}
function getErrorMap() {
  return overrideErrorMap;
}

// node_modules/zod/v3/helpers/parseUtil.js
var makeIssue = (params) => {
  const { data, path, errorMaps, issueData } = params;
  const fullPath = [...path, ...issueData.path || []];
  const fullIssue = {
    ...issueData,
    path: fullPath
  };
  if (issueData.message !== void 0) {
    return {
      ...issueData,
      path: fullPath,
      message: issueData.message
    };
  }
  let errorMessage = "";
  const maps = errorMaps.filter((m) => !!m).slice().reverse();
  for (const map of maps) {
    errorMessage = map(fullIssue, { data, defaultError: errorMessage }).message;
  }
  return {
    ...issueData,
    path: fullPath,
    message: errorMessage
  };
};
var EMPTY_PATH = [];
function addIssueToContext(ctx, issueData) {
  const overrideMap = getErrorMap();
  const issue = makeIssue({
    issueData,
    data: ctx.data,
    path: ctx.path,
    errorMaps: [
      ctx.common.contextualErrorMap,
      // contextual error map is first priority
      ctx.schemaErrorMap,
      // then schema-bound map if available
      overrideMap,
      // then global override map
      overrideMap === en_default ? void 0 : en_default
      // then global default map
    ].filter((x) => !!x)
  });
  ctx.common.issues.push(issue);
}
var ParseStatus = class _ParseStatus {
  constructor() {
    this.value = "valid";
  }
  dirty() {
    if (this.value === "valid")
      this.value = "dirty";
  }
  abort() {
    if (this.value !== "aborted")
      this.value = "aborted";
  }
  static mergeArray(status, results) {
    const arrayValue = [];
    for (const s of results) {
      if (s.status === "aborted")
        return INVALID;
      if (s.status === "dirty")
        status.dirty();
      arrayValue.push(s.value);
    }
    return { status: status.value, value: arrayValue };
  }
  static async mergeObjectAsync(status, pairs) {
    const syncPairs = [];
    for (const pair of pairs) {
      const key = await pair.key;
      const value = await pair.value;
      syncPairs.push({
        key,
        value
      });
    }
    return _ParseStatus.mergeObjectSync(status, syncPairs);
  }
  static mergeObjectSync(status, pairs) {
    const finalObject = {};
    for (const pair of pairs) {
      const { key, value } = pair;
      if (key.status === "aborted")
        return INVALID;
      if (value.status === "aborted")
        return INVALID;
      if (key.status === "dirty")
        status.dirty();
      if (value.status === "dirty")
        status.dirty();
      if (key.value !== "__proto__" && (typeof value.value !== "undefined" || pair.alwaysSet)) {
        finalObject[key.value] = value.value;
      }
    }
    return { status: status.value, value: finalObject };
  }
};
var INVALID = Object.freeze({
  status: "aborted"
});
var DIRTY = (value) => ({ status: "dirty", value });
var OK = (value) => ({ status: "valid", value });
var isAborted = (x) => x.status === "aborted";
var isDirty = (x) => x.status === "dirty";
var isValid = (x) => x.status === "valid";
var isAsync = (x) => typeof Promise !== "undefined" && x instanceof Promise;

// node_modules/zod/v3/helpers/errorUtil.js
var errorUtil;
(function(errorUtil2) {
  errorUtil2.errToObj = (message) => typeof message === "string" ? { message } : message || {};
  errorUtil2.toString = (message) => typeof message === "string" ? message : message?.message;
})(errorUtil || (errorUtil = {}));

// node_modules/zod/v3/types.js
var ParseInputLazyPath = class {
  constructor(parent, value, path, key) {
    this._cachedPath = [];
    this.parent = parent;
    this.data = value;
    this._path = path;
    this._key = key;
  }
  get path() {
    if (!this._cachedPath.length) {
      if (Array.isArray(this._key)) {
        this._cachedPath.push(...this._path, ...this._key);
      } else {
        this._cachedPath.push(...this._path, this._key);
      }
    }
    return this._cachedPath;
  }
};
var handleResult = (ctx, result) => {
  if (isValid(result)) {
    return { success: true, data: result.value };
  } else {
    if (!ctx.common.issues.length) {
      throw new Error("Validation failed but no issues detected.");
    }
    return {
      success: false,
      get error() {
        if (this._error)
          return this._error;
        const error = new ZodError(ctx.common.issues);
        this._error = error;
        return this._error;
      }
    };
  }
};
function processCreateParams(params) {
  if (!params)
    return {};
  const { errorMap: errorMap2, invalid_type_error, required_error, description } = params;
  if (errorMap2 && (invalid_type_error || required_error)) {
    throw new Error(`Can't use "invalid_type_error" or "required_error" in conjunction with custom error map.`);
  }
  if (errorMap2)
    return { errorMap: errorMap2, description };
  const customMap = (iss, ctx) => {
    const { message } = params;
    if (iss.code === "invalid_enum_value") {
      return { message: message ?? ctx.defaultError };
    }
    if (typeof ctx.data === "undefined") {
      return { message: message ?? required_error ?? ctx.defaultError };
    }
    if (iss.code !== "invalid_type")
      return { message: ctx.defaultError };
    return { message: message ?? invalid_type_error ?? ctx.defaultError };
  };
  return { errorMap: customMap, description };
}
var ZodType = class {
  get description() {
    return this._def.description;
  }
  _getType(input) {
    return getParsedType(input.data);
  }
  _getOrReturnCtx(input, ctx) {
    return ctx || {
      common: input.parent.common,
      data: input.data,
      parsedType: getParsedType(input.data),
      schemaErrorMap: this._def.errorMap,
      path: input.path,
      parent: input.parent
    };
  }
  _processInputParams(input) {
    return {
      status: new ParseStatus(),
      ctx: {
        common: input.parent.common,
        data: input.data,
        parsedType: getParsedType(input.data),
        schemaErrorMap: this._def.errorMap,
        path: input.path,
        parent: input.parent
      }
    };
  }
  _parseSync(input) {
    const result = this._parse(input);
    if (isAsync(result)) {
      throw new Error("Synchronous parse encountered promise.");
    }
    return result;
  }
  _parseAsync(input) {
    const result = this._parse(input);
    return Promise.resolve(result);
  }
  parse(data, params) {
    const result = this.safeParse(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  safeParse(data, params) {
    const ctx = {
      common: {
        issues: [],
        async: params?.async ?? false,
        contextualErrorMap: params?.errorMap
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const result = this._parseSync({ data, path: ctx.path, parent: ctx });
    return handleResult(ctx, result);
  }
  "~validate"(data) {
    const ctx = {
      common: {
        issues: [],
        async: !!this["~standard"].async
      },
      path: [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    if (!this["~standard"].async) {
      try {
        const result = this._parseSync({ data, path: [], parent: ctx });
        return isValid(result) ? {
          value: result.value
        } : {
          issues: ctx.common.issues
        };
      } catch (err) {
        if (err?.message?.toLowerCase()?.includes("encountered")) {
          this["~standard"].async = true;
        }
        ctx.common = {
          issues: [],
          async: true
        };
      }
    }
    return this._parseAsync({ data, path: [], parent: ctx }).then((result) => isValid(result) ? {
      value: result.value
    } : {
      issues: ctx.common.issues
    });
  }
  async parseAsync(data, params) {
    const result = await this.safeParseAsync(data, params);
    if (result.success)
      return result.data;
    throw result.error;
  }
  async safeParseAsync(data, params) {
    const ctx = {
      common: {
        issues: [],
        contextualErrorMap: params?.errorMap,
        async: true
      },
      path: params?.path || [],
      schemaErrorMap: this._def.errorMap,
      parent: null,
      data,
      parsedType: getParsedType(data)
    };
    const maybeAsyncResult = this._parse({ data, path: ctx.path, parent: ctx });
    const result = await (isAsync(maybeAsyncResult) ? maybeAsyncResult : Promise.resolve(maybeAsyncResult));
    return handleResult(ctx, result);
  }
  refine(check, message) {
    const getIssueProperties = (val) => {
      if (typeof message === "string" || typeof message === "undefined") {
        return { message };
      } else if (typeof message === "function") {
        return message(val);
      } else {
        return message;
      }
    };
    return this._refinement((val, ctx) => {
      const result = check(val);
      const setError = () => ctx.addIssue({
        code: ZodIssueCode.custom,
        ...getIssueProperties(val)
      });
      if (typeof Promise !== "undefined" && result instanceof Promise) {
        return result.then((data) => {
          if (!data) {
            setError();
            return false;
          } else {
            return true;
          }
        });
      }
      if (!result) {
        setError();
        return false;
      } else {
        return true;
      }
    });
  }
  refinement(check, refinementData) {
    return this._refinement((val, ctx) => {
      if (!check(val)) {
        ctx.addIssue(typeof refinementData === "function" ? refinementData(val, ctx) : refinementData);
        return false;
      } else {
        return true;
      }
    });
  }
  _refinement(refinement) {
    return new ZodEffects({
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "refinement", refinement }
    });
  }
  superRefine(refinement) {
    return this._refinement(refinement);
  }
  constructor(def) {
    this.spa = this.safeParseAsync;
    this._def = def;
    this.parse = this.parse.bind(this);
    this.safeParse = this.safeParse.bind(this);
    this.parseAsync = this.parseAsync.bind(this);
    this.safeParseAsync = this.safeParseAsync.bind(this);
    this.spa = this.spa.bind(this);
    this.refine = this.refine.bind(this);
    this.refinement = this.refinement.bind(this);
    this.superRefine = this.superRefine.bind(this);
    this.optional = this.optional.bind(this);
    this.nullable = this.nullable.bind(this);
    this.nullish = this.nullish.bind(this);
    this.array = this.array.bind(this);
    this.promise = this.promise.bind(this);
    this.or = this.or.bind(this);
    this.and = this.and.bind(this);
    this.transform = this.transform.bind(this);
    this.brand = this.brand.bind(this);
    this.default = this.default.bind(this);
    this.catch = this.catch.bind(this);
    this.describe = this.describe.bind(this);
    this.pipe = this.pipe.bind(this);
    this.readonly = this.readonly.bind(this);
    this.isNullable = this.isNullable.bind(this);
    this.isOptional = this.isOptional.bind(this);
    this["~standard"] = {
      version: 1,
      vendor: "zod",
      validate: (data) => this["~validate"](data)
    };
  }
  optional() {
    return ZodOptional.create(this, this._def);
  }
  nullable() {
    return ZodNullable.create(this, this._def);
  }
  nullish() {
    return this.nullable().optional();
  }
  array() {
    return ZodArray.create(this);
  }
  promise() {
    return ZodPromise.create(this, this._def);
  }
  or(option) {
    return ZodUnion.create([this, option], this._def);
  }
  and(incoming) {
    return ZodIntersection.create(this, incoming, this._def);
  }
  transform(transform) {
    return new ZodEffects({
      ...processCreateParams(this._def),
      schema: this,
      typeName: ZodFirstPartyTypeKind.ZodEffects,
      effect: { type: "transform", transform }
    });
  }
  default(def) {
    const defaultValueFunc = typeof def === "function" ? def : () => def;
    return new ZodDefault({
      ...processCreateParams(this._def),
      innerType: this,
      defaultValue: defaultValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodDefault
    });
  }
  brand() {
    return new ZodBranded({
      typeName: ZodFirstPartyTypeKind.ZodBranded,
      type: this,
      ...processCreateParams(this._def)
    });
  }
  catch(def) {
    const catchValueFunc = typeof def === "function" ? def : () => def;
    return new ZodCatch({
      ...processCreateParams(this._def),
      innerType: this,
      catchValue: catchValueFunc,
      typeName: ZodFirstPartyTypeKind.ZodCatch
    });
  }
  describe(description) {
    const This = this.constructor;
    return new This({
      ...this._def,
      description
    });
  }
  pipe(target) {
    return ZodPipeline.create(this, target);
  }
  readonly() {
    return ZodReadonly.create(this);
  }
  isOptional() {
    return this.safeParse(void 0).success;
  }
  isNullable() {
    return this.safeParse(null).success;
  }
};
var cuidRegex = /^c[^\s-]{8,}$/i;
var cuid2Regex = /^[0-9a-z]+$/;
var ulidRegex = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
var uuidRegex = /^[0-9a-fA-F]{8}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{4}\b-[0-9a-fA-F]{12}$/i;
var nanoidRegex = /^[a-z0-9_-]{21}$/i;
var jwtRegex = /^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]*$/;
var durationRegex = /^[-+]?P(?!$)(?:(?:[-+]?\d+Y)|(?:[-+]?\d+[.,]\d+Y$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:(?:[-+]?\d+W)|(?:[-+]?\d+[.,]\d+W$))?(?:(?:[-+]?\d+D)|(?:[-+]?\d+[.,]\d+D$))?(?:T(?=[\d+-])(?:(?:[-+]?\d+H)|(?:[-+]?\d+[.,]\d+H$))?(?:(?:[-+]?\d+M)|(?:[-+]?\d+[.,]\d+M$))?(?:[-+]?\d+(?:[.,]\d+)?S)?)??$/;
var emailRegex = /^(?!\.)(?!.*\.\.)([A-Z0-9_'+\-\.]*)[A-Z0-9_+-]@([A-Z0-9][A-Z0-9\-]*\.)+[A-Z]{2,}$/i;
var _emojiRegex = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
var emojiRegex;
var ipv4Regex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
var ipv4CidrRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/(3[0-2]|[12]?[0-9])$/;
var ipv6Regex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))$/;
var ipv6CidrRegex = /^(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
var base64Regex = /^([0-9a-zA-Z+/]{4})*(([0-9a-zA-Z+/]{2}==)|([0-9a-zA-Z+/]{3}=))?$/;
var base64urlRegex = /^([0-9a-zA-Z-_]{4})*(([0-9a-zA-Z-_]{2}(==)?)|([0-9a-zA-Z-_]{3}(=)?))?$/;
var dateRegexSource = `((\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-((0[13578]|1[02])-(0[1-9]|[12]\\d|3[01])|(0[469]|11)-(0[1-9]|[12]\\d|30)|(02)-(0[1-9]|1\\d|2[0-8])))`;
var dateRegex = new RegExp(`^${dateRegexSource}$`);
function timeRegexSource(args) {
  let secondsRegexSource = `[0-5]\\d`;
  if (args.precision) {
    secondsRegexSource = `${secondsRegexSource}\\.\\d{${args.precision}}`;
  } else if (args.precision == null) {
    secondsRegexSource = `${secondsRegexSource}(\\.\\d+)?`;
  }
  const secondsQuantifier = args.precision ? "+" : "?";
  return `([01]\\d|2[0-3]):[0-5]\\d(:${secondsRegexSource})${secondsQuantifier}`;
}
function timeRegex(args) {
  return new RegExp(`^${timeRegexSource(args)}$`);
}
function datetimeRegex(args) {
  let regex = `${dateRegexSource}T${timeRegexSource(args)}`;
  const opts = [];
  opts.push(args.local ? `Z?` : `Z`);
  if (args.offset)
    opts.push(`([+-]\\d{2}:?\\d{2})`);
  regex = `${regex}(${opts.join("|")})`;
  return new RegExp(`^${regex}$`);
}
function isValidIP(ip, version) {
  if ((version === "v4" || !version) && ipv4Regex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6Regex.test(ip)) {
    return true;
  }
  return false;
}
function isValidJWT(jwt, alg) {
  if (!jwtRegex.test(jwt))
    return false;
  try {
    const [header] = jwt.split(".");
    if (!header)
      return false;
    const base64 = header.replace(/-/g, "+").replace(/_/g, "/").padEnd(header.length + (4 - header.length % 4) % 4, "=");
    const decoded = JSON.parse(atob(base64));
    if (typeof decoded !== "object" || decoded === null)
      return false;
    if ("typ" in decoded && decoded?.typ !== "JWT")
      return false;
    if (!decoded.alg)
      return false;
    if (alg && decoded.alg !== alg)
      return false;
    return true;
  } catch {
    return false;
  }
}
function isValidCidr(ip, version) {
  if ((version === "v4" || !version) && ipv4CidrRegex.test(ip)) {
    return true;
  }
  if ((version === "v6" || !version) && ipv6CidrRegex.test(ip)) {
    return true;
  }
  return false;
}
var ZodString = class _ZodString extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = String(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.string) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.string,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.length < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.length > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "string",
            inclusive: true,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "length") {
        const tooBig = input.data.length > check.value;
        const tooSmall = input.data.length < check.value;
        if (tooBig || tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          if (tooBig) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_big,
              maximum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          } else if (tooSmall) {
            addIssueToContext(ctx, {
              code: ZodIssueCode.too_small,
              minimum: check.value,
              type: "string",
              inclusive: true,
              exact: true,
              message: check.message
            });
          }
          status.dirty();
        }
      } else if (check.kind === "email") {
        if (!emailRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "email",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "emoji") {
        if (!emojiRegex) {
          emojiRegex = new RegExp(_emojiRegex, "u");
        }
        if (!emojiRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "emoji",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "uuid") {
        if (!uuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "uuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "nanoid") {
        if (!nanoidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "nanoid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid") {
        if (!cuidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cuid2") {
        if (!cuid2Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cuid2",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ulid") {
        if (!ulidRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ulid",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "url") {
        try {
          new URL(input.data);
        } catch {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "regex") {
        check.regex.lastIndex = 0;
        const testResult = check.regex.test(input.data);
        if (!testResult) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "regex",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "trim") {
        input.data = input.data.trim();
      } else if (check.kind === "includes") {
        if (!input.data.includes(check.value, check.position)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { includes: check.value, position: check.position },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "toLowerCase") {
        input.data = input.data.toLowerCase();
      } else if (check.kind === "toUpperCase") {
        input.data = input.data.toUpperCase();
      } else if (check.kind === "startsWith") {
        if (!input.data.startsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { startsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "endsWith") {
        if (!input.data.endsWith(check.value)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: { endsWith: check.value },
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "datetime") {
        const regex = datetimeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "datetime",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "date") {
        const regex = dateRegex;
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "date",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "time") {
        const regex = timeRegex(check);
        if (!regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_string,
            validation: "time",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "duration") {
        if (!durationRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "duration",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "ip") {
        if (!isValidIP(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "ip",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "jwt") {
        if (!isValidJWT(input.data, check.alg)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "jwt",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "cidr") {
        if (!isValidCidr(input.data, check.version)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "cidr",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64") {
        if (!base64Regex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "base64url") {
        if (!base64urlRegex.test(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            validation: "base64url",
            code: ZodIssueCode.invalid_string,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _regex(regex, validation, message) {
    return this.refinement((data) => regex.test(data), {
      validation,
      code: ZodIssueCode.invalid_string,
      ...errorUtil.errToObj(message)
    });
  }
  _addCheck(check) {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  email(message) {
    return this._addCheck({ kind: "email", ...errorUtil.errToObj(message) });
  }
  url(message) {
    return this._addCheck({ kind: "url", ...errorUtil.errToObj(message) });
  }
  emoji(message) {
    return this._addCheck({ kind: "emoji", ...errorUtil.errToObj(message) });
  }
  uuid(message) {
    return this._addCheck({ kind: "uuid", ...errorUtil.errToObj(message) });
  }
  nanoid(message) {
    return this._addCheck({ kind: "nanoid", ...errorUtil.errToObj(message) });
  }
  cuid(message) {
    return this._addCheck({ kind: "cuid", ...errorUtil.errToObj(message) });
  }
  cuid2(message) {
    return this._addCheck({ kind: "cuid2", ...errorUtil.errToObj(message) });
  }
  ulid(message) {
    return this._addCheck({ kind: "ulid", ...errorUtil.errToObj(message) });
  }
  base64(message) {
    return this._addCheck({ kind: "base64", ...errorUtil.errToObj(message) });
  }
  base64url(message) {
    return this._addCheck({
      kind: "base64url",
      ...errorUtil.errToObj(message)
    });
  }
  jwt(options) {
    return this._addCheck({ kind: "jwt", ...errorUtil.errToObj(options) });
  }
  ip(options) {
    return this._addCheck({ kind: "ip", ...errorUtil.errToObj(options) });
  }
  cidr(options) {
    return this._addCheck({ kind: "cidr", ...errorUtil.errToObj(options) });
  }
  datetime(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "datetime",
        precision: null,
        offset: false,
        local: false,
        message: options
      });
    }
    return this._addCheck({
      kind: "datetime",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      offset: options?.offset ?? false,
      local: options?.local ?? false,
      ...errorUtil.errToObj(options?.message)
    });
  }
  date(message) {
    return this._addCheck({ kind: "date", message });
  }
  time(options) {
    if (typeof options === "string") {
      return this._addCheck({
        kind: "time",
        precision: null,
        message: options
      });
    }
    return this._addCheck({
      kind: "time",
      precision: typeof options?.precision === "undefined" ? null : options?.precision,
      ...errorUtil.errToObj(options?.message)
    });
  }
  duration(message) {
    return this._addCheck({ kind: "duration", ...errorUtil.errToObj(message) });
  }
  regex(regex, message) {
    return this._addCheck({
      kind: "regex",
      regex,
      ...errorUtil.errToObj(message)
    });
  }
  includes(value, options) {
    return this._addCheck({
      kind: "includes",
      value,
      position: options?.position,
      ...errorUtil.errToObj(options?.message)
    });
  }
  startsWith(value, message) {
    return this._addCheck({
      kind: "startsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  endsWith(value, message) {
    return this._addCheck({
      kind: "endsWith",
      value,
      ...errorUtil.errToObj(message)
    });
  }
  min(minLength, message) {
    return this._addCheck({
      kind: "min",
      value: minLength,
      ...errorUtil.errToObj(message)
    });
  }
  max(maxLength, message) {
    return this._addCheck({
      kind: "max",
      value: maxLength,
      ...errorUtil.errToObj(message)
    });
  }
  length(len, message) {
    return this._addCheck({
      kind: "length",
      value: len,
      ...errorUtil.errToObj(message)
    });
  }
  /**
   * Equivalent to `.min(1)`
   */
  nonempty(message) {
    return this.min(1, errorUtil.errToObj(message));
  }
  trim() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "trim" }]
    });
  }
  toLowerCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toLowerCase" }]
    });
  }
  toUpperCase() {
    return new _ZodString({
      ...this._def,
      checks: [...this._def.checks, { kind: "toUpperCase" }]
    });
  }
  get isDatetime() {
    return !!this._def.checks.find((ch) => ch.kind === "datetime");
  }
  get isDate() {
    return !!this._def.checks.find((ch) => ch.kind === "date");
  }
  get isTime() {
    return !!this._def.checks.find((ch) => ch.kind === "time");
  }
  get isDuration() {
    return !!this._def.checks.find((ch) => ch.kind === "duration");
  }
  get isEmail() {
    return !!this._def.checks.find((ch) => ch.kind === "email");
  }
  get isURL() {
    return !!this._def.checks.find((ch) => ch.kind === "url");
  }
  get isEmoji() {
    return !!this._def.checks.find((ch) => ch.kind === "emoji");
  }
  get isUUID() {
    return !!this._def.checks.find((ch) => ch.kind === "uuid");
  }
  get isNANOID() {
    return !!this._def.checks.find((ch) => ch.kind === "nanoid");
  }
  get isCUID() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid");
  }
  get isCUID2() {
    return !!this._def.checks.find((ch) => ch.kind === "cuid2");
  }
  get isULID() {
    return !!this._def.checks.find((ch) => ch.kind === "ulid");
  }
  get isIP() {
    return !!this._def.checks.find((ch) => ch.kind === "ip");
  }
  get isCIDR() {
    return !!this._def.checks.find((ch) => ch.kind === "cidr");
  }
  get isBase64() {
    return !!this._def.checks.find((ch) => ch.kind === "base64");
  }
  get isBase64url() {
    return !!this._def.checks.find((ch) => ch.kind === "base64url");
  }
  get minLength() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxLength() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodString.create = (params) => {
  return new ZodString({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodString,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
function floatSafeRemainder(val, step) {
  const valDecCount = (val.toString().split(".")[1] || "").length;
  const stepDecCount = (step.toString().split(".")[1] || "").length;
  const decCount = valDecCount > stepDecCount ? valDecCount : stepDecCount;
  const valInt = Number.parseInt(val.toFixed(decCount).replace(".", ""));
  const stepInt = Number.parseInt(step.toFixed(decCount).replace(".", ""));
  return valInt % stepInt / 10 ** decCount;
}
var ZodNumber = class _ZodNumber extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
    this.step = this.multipleOf;
  }
  _parse(input) {
    if (this._def.coerce) {
      input.data = Number(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.number) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.number,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "int") {
        if (!util.isInteger(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.invalid_type,
            expected: "integer",
            received: "float",
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            minimum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            maximum: check.value,
            type: "number",
            inclusive: check.inclusive,
            exact: false,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (floatSafeRemainder(input.data, check.value) !== 0) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "finite") {
        if (!Number.isFinite(input.data)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_finite,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodNumber({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodNumber({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  int(message) {
    return this._addCheck({
      kind: "int",
      message: errorUtil.toString(message)
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: 0,
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  finite(message) {
    return this._addCheck({
      kind: "finite",
      message: errorUtil.toString(message)
    });
  }
  safe(message) {
    return this._addCheck({
      kind: "min",
      inclusive: true,
      value: Number.MIN_SAFE_INTEGER,
      message: errorUtil.toString(message)
    })._addCheck({
      kind: "max",
      inclusive: true,
      value: Number.MAX_SAFE_INTEGER,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
  get isInt() {
    return !!this._def.checks.find((ch) => ch.kind === "int" || ch.kind === "multipleOf" && util.isInteger(ch.value));
  }
  get isFinite() {
    let max = null;
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "finite" || ch.kind === "int" || ch.kind === "multipleOf") {
        return true;
      } else if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      } else if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return Number.isFinite(min) && Number.isFinite(max);
  }
};
ZodNumber.create = (params) => {
  return new ZodNumber({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodNumber,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodBigInt = class _ZodBigInt extends ZodType {
  constructor() {
    super(...arguments);
    this.min = this.gte;
    this.max = this.lte;
  }
  _parse(input) {
    if (this._def.coerce) {
      try {
        input.data = BigInt(input.data);
      } catch {
        return this._getInvalidInput(input);
      }
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.bigint) {
      return this._getInvalidInput(input);
    }
    let ctx = void 0;
    const status = new ParseStatus();
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        const tooSmall = check.inclusive ? input.data < check.value : input.data <= check.value;
        if (tooSmall) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            type: "bigint",
            minimum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        const tooBig = check.inclusive ? input.data > check.value : input.data >= check.value;
        if (tooBig) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            type: "bigint",
            maximum: check.value,
            inclusive: check.inclusive,
            message: check.message
          });
          status.dirty();
        }
      } else if (check.kind === "multipleOf") {
        if (input.data % check.value !== BigInt(0)) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.not_multiple_of,
            multipleOf: check.value,
            message: check.message
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return { status: status.value, value: input.data };
  }
  _getInvalidInput(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.bigint,
      received: ctx.parsedType
    });
    return INVALID;
  }
  gte(value, message) {
    return this.setLimit("min", value, true, errorUtil.toString(message));
  }
  gt(value, message) {
    return this.setLimit("min", value, false, errorUtil.toString(message));
  }
  lte(value, message) {
    return this.setLimit("max", value, true, errorUtil.toString(message));
  }
  lt(value, message) {
    return this.setLimit("max", value, false, errorUtil.toString(message));
  }
  setLimit(kind, value, inclusive, message) {
    return new _ZodBigInt({
      ...this._def,
      checks: [
        ...this._def.checks,
        {
          kind,
          value,
          inclusive,
          message: errorUtil.toString(message)
        }
      ]
    });
  }
  _addCheck(check) {
    return new _ZodBigInt({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  positive(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  negative(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: false,
      message: errorUtil.toString(message)
    });
  }
  nonpositive(message) {
    return this._addCheck({
      kind: "max",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  nonnegative(message) {
    return this._addCheck({
      kind: "min",
      value: BigInt(0),
      inclusive: true,
      message: errorUtil.toString(message)
    });
  }
  multipleOf(value, message) {
    return this._addCheck({
      kind: "multipleOf",
      value,
      message: errorUtil.toString(message)
    });
  }
  get minValue() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min;
  }
  get maxValue() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max;
  }
};
ZodBigInt.create = (params) => {
  return new ZodBigInt({
    checks: [],
    typeName: ZodFirstPartyTypeKind.ZodBigInt,
    coerce: params?.coerce ?? false,
    ...processCreateParams(params)
  });
};
var ZodBoolean = class extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = Boolean(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.boolean) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.boolean,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodBoolean.create = (params) => {
  return new ZodBoolean({
    typeName: ZodFirstPartyTypeKind.ZodBoolean,
    coerce: params?.coerce || false,
    ...processCreateParams(params)
  });
};
var ZodDate = class _ZodDate extends ZodType {
  _parse(input) {
    if (this._def.coerce) {
      input.data = new Date(input.data);
    }
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.date) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.date,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    if (Number.isNaN(input.data.getTime())) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_date
      });
      return INVALID;
    }
    const status = new ParseStatus();
    let ctx = void 0;
    for (const check of this._def.checks) {
      if (check.kind === "min") {
        if (input.data.getTime() < check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_small,
            message: check.message,
            inclusive: true,
            exact: false,
            minimum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else if (check.kind === "max") {
        if (input.data.getTime() > check.value) {
          ctx = this._getOrReturnCtx(input, ctx);
          addIssueToContext(ctx, {
            code: ZodIssueCode.too_big,
            message: check.message,
            inclusive: true,
            exact: false,
            maximum: check.value,
            type: "date"
          });
          status.dirty();
        }
      } else {
        util.assertNever(check);
      }
    }
    return {
      status: status.value,
      value: new Date(input.data.getTime())
    };
  }
  _addCheck(check) {
    return new _ZodDate({
      ...this._def,
      checks: [...this._def.checks, check]
    });
  }
  min(minDate, message) {
    return this._addCheck({
      kind: "min",
      value: minDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  max(maxDate, message) {
    return this._addCheck({
      kind: "max",
      value: maxDate.getTime(),
      message: errorUtil.toString(message)
    });
  }
  get minDate() {
    let min = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "min") {
        if (min === null || ch.value > min)
          min = ch.value;
      }
    }
    return min != null ? new Date(min) : null;
  }
  get maxDate() {
    let max = null;
    for (const ch of this._def.checks) {
      if (ch.kind === "max") {
        if (max === null || ch.value < max)
          max = ch.value;
      }
    }
    return max != null ? new Date(max) : null;
  }
};
ZodDate.create = (params) => {
  return new ZodDate({
    checks: [],
    coerce: params?.coerce || false,
    typeName: ZodFirstPartyTypeKind.ZodDate,
    ...processCreateParams(params)
  });
};
var ZodSymbol = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.symbol) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.symbol,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodSymbol.create = (params) => {
  return new ZodSymbol({
    typeName: ZodFirstPartyTypeKind.ZodSymbol,
    ...processCreateParams(params)
  });
};
var ZodUndefined = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.undefined,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodUndefined.create = (params) => {
  return new ZodUndefined({
    typeName: ZodFirstPartyTypeKind.ZodUndefined,
    ...processCreateParams(params)
  });
};
var ZodNull = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.null) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.null,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodNull.create = (params) => {
  return new ZodNull({
    typeName: ZodFirstPartyTypeKind.ZodNull,
    ...processCreateParams(params)
  });
};
var ZodAny = class extends ZodType {
  constructor() {
    super(...arguments);
    this._any = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodAny.create = (params) => {
  return new ZodAny({
    typeName: ZodFirstPartyTypeKind.ZodAny,
    ...processCreateParams(params)
  });
};
var ZodUnknown = class extends ZodType {
  constructor() {
    super(...arguments);
    this._unknown = true;
  }
  _parse(input) {
    return OK(input.data);
  }
};
ZodUnknown.create = (params) => {
  return new ZodUnknown({
    typeName: ZodFirstPartyTypeKind.ZodUnknown,
    ...processCreateParams(params)
  });
};
var ZodNever = class extends ZodType {
  _parse(input) {
    const ctx = this._getOrReturnCtx(input);
    addIssueToContext(ctx, {
      code: ZodIssueCode.invalid_type,
      expected: ZodParsedType.never,
      received: ctx.parsedType
    });
    return INVALID;
  }
};
ZodNever.create = (params) => {
  return new ZodNever({
    typeName: ZodFirstPartyTypeKind.ZodNever,
    ...processCreateParams(params)
  });
};
var ZodVoid = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.undefined) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.void,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return OK(input.data);
  }
};
ZodVoid.create = (params) => {
  return new ZodVoid({
    typeName: ZodFirstPartyTypeKind.ZodVoid,
    ...processCreateParams(params)
  });
};
var ZodArray = class _ZodArray extends ZodType {
  _parse(input) {
    const { ctx, status } = this._processInputParams(input);
    const def = this._def;
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (def.exactLength !== null) {
      const tooBig = ctx.data.length > def.exactLength.value;
      const tooSmall = ctx.data.length < def.exactLength.value;
      if (tooBig || tooSmall) {
        addIssueToContext(ctx, {
          code: tooBig ? ZodIssueCode.too_big : ZodIssueCode.too_small,
          minimum: tooSmall ? def.exactLength.value : void 0,
          maximum: tooBig ? def.exactLength.value : void 0,
          type: "array",
          inclusive: true,
          exact: true,
          message: def.exactLength.message
        });
        status.dirty();
      }
    }
    if (def.minLength !== null) {
      if (ctx.data.length < def.minLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.minLength.message
        });
        status.dirty();
      }
    }
    if (def.maxLength !== null) {
      if (ctx.data.length > def.maxLength.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxLength.value,
          type: "array",
          inclusive: true,
          exact: false,
          message: def.maxLength.message
        });
        status.dirty();
      }
    }
    if (ctx.common.async) {
      return Promise.all([...ctx.data].map((item, i) => {
        return def.type._parseAsync(new ParseInputLazyPath(ctx, item, ctx.path, i));
      })).then((result2) => {
        return ParseStatus.mergeArray(status, result2);
      });
    }
    const result = [...ctx.data].map((item, i) => {
      return def.type._parseSync(new ParseInputLazyPath(ctx, item, ctx.path, i));
    });
    return ParseStatus.mergeArray(status, result);
  }
  get element() {
    return this._def.type;
  }
  min(minLength, message) {
    return new _ZodArray({
      ...this._def,
      minLength: { value: minLength, message: errorUtil.toString(message) }
    });
  }
  max(maxLength, message) {
    return new _ZodArray({
      ...this._def,
      maxLength: { value: maxLength, message: errorUtil.toString(message) }
    });
  }
  length(len, message) {
    return new _ZodArray({
      ...this._def,
      exactLength: { value: len, message: errorUtil.toString(message) }
    });
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodArray.create = (schema, params) => {
  return new ZodArray({
    type: schema,
    minLength: null,
    maxLength: null,
    exactLength: null,
    typeName: ZodFirstPartyTypeKind.ZodArray,
    ...processCreateParams(params)
  });
};
function deepPartialify(schema) {
  if (schema instanceof ZodObject) {
    const newShape = {};
    for (const key in schema.shape) {
      const fieldSchema = schema.shape[key];
      newShape[key] = ZodOptional.create(deepPartialify(fieldSchema));
    }
    return new ZodObject({
      ...schema._def,
      shape: () => newShape
    });
  } else if (schema instanceof ZodArray) {
    return new ZodArray({
      ...schema._def,
      type: deepPartialify(schema.element)
    });
  } else if (schema instanceof ZodOptional) {
    return ZodOptional.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodNullable) {
    return ZodNullable.create(deepPartialify(schema.unwrap()));
  } else if (schema instanceof ZodTuple) {
    return ZodTuple.create(schema.items.map((item) => deepPartialify(item)));
  } else {
    return schema;
  }
}
var ZodObject = class _ZodObject extends ZodType {
  constructor() {
    super(...arguments);
    this._cached = null;
    this.nonstrict = this.passthrough;
    this.augment = this.extend;
  }
  _getCached() {
    if (this._cached !== null)
      return this._cached;
    const shape = this._def.shape();
    const keys = util.objectKeys(shape);
    this._cached = { shape, keys };
    return this._cached;
  }
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.object) {
      const ctx2 = this._getOrReturnCtx(input);
      addIssueToContext(ctx2, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx2.parsedType
      });
      return INVALID;
    }
    const { status, ctx } = this._processInputParams(input);
    const { shape, keys: shapeKeys } = this._getCached();
    const extraKeys = [];
    if (!(this._def.catchall instanceof ZodNever && this._def.unknownKeys === "strip")) {
      for (const key in ctx.data) {
        if (!shapeKeys.includes(key)) {
          extraKeys.push(key);
        }
      }
    }
    const pairs = [];
    for (const key of shapeKeys) {
      const keyValidator = shape[key];
      const value = ctx.data[key];
      pairs.push({
        key: { status: "valid", value: key },
        value: keyValidator._parse(new ParseInputLazyPath(ctx, value, ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (this._def.catchall instanceof ZodNever) {
      const unknownKeys = this._def.unknownKeys;
      if (unknownKeys === "passthrough") {
        for (const key of extraKeys) {
          pairs.push({
            key: { status: "valid", value: key },
            value: { status: "valid", value: ctx.data[key] }
          });
        }
      } else if (unknownKeys === "strict") {
        if (extraKeys.length > 0) {
          addIssueToContext(ctx, {
            code: ZodIssueCode.unrecognized_keys,
            keys: extraKeys
          });
          status.dirty();
        }
      } else if (unknownKeys === "strip") {
      } else {
        throw new Error(`Internal ZodObject error: invalid unknownKeys value.`);
      }
    } else {
      const catchall = this._def.catchall;
      for (const key of extraKeys) {
        const value = ctx.data[key];
        pairs.push({
          key: { status: "valid", value: key },
          value: catchall._parse(
            new ParseInputLazyPath(ctx, value, ctx.path, key)
            //, ctx.child(key), value, getParsedType(value)
          ),
          alwaysSet: key in ctx.data
        });
      }
    }
    if (ctx.common.async) {
      return Promise.resolve().then(async () => {
        const syncPairs = [];
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          syncPairs.push({
            key,
            value,
            alwaysSet: pair.alwaysSet
          });
        }
        return syncPairs;
      }).then((syncPairs) => {
        return ParseStatus.mergeObjectSync(status, syncPairs);
      });
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get shape() {
    return this._def.shape();
  }
  strict(message) {
    errorUtil.errToObj;
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strict",
      ...message !== void 0 ? {
        errorMap: (issue, ctx) => {
          const defaultError = this._def.errorMap?.(issue, ctx).message ?? ctx.defaultError;
          if (issue.code === "unrecognized_keys")
            return {
              message: errorUtil.errToObj(message).message ?? defaultError
            };
          return {
            message: defaultError
          };
        }
      } : {}
    });
  }
  strip() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "strip"
    });
  }
  passthrough() {
    return new _ZodObject({
      ...this._def,
      unknownKeys: "passthrough"
    });
  }
  // const AugmentFactory =
  //   <Def extends ZodObjectDef>(def: Def) =>
  //   <Augmentation extends ZodRawShape>(
  //     augmentation: Augmentation
  //   ): ZodObject<
  //     extendShape<ReturnType<Def["shape"]>, Augmentation>,
  //     Def["unknownKeys"],
  //     Def["catchall"]
  //   > => {
  //     return new ZodObject({
  //       ...def,
  //       shape: () => ({
  //         ...def.shape(),
  //         ...augmentation,
  //       }),
  //     }) as any;
  //   };
  extend(augmentation) {
    return new _ZodObject({
      ...this._def,
      shape: () => ({
        ...this._def.shape(),
        ...augmentation
      })
    });
  }
  /**
   * Prior to zod@1.0.12 there was a bug in the
   * inferred type of merged objects. Please
   * upgrade if you are experiencing issues.
   */
  merge(merging) {
    const merged = new _ZodObject({
      unknownKeys: merging._def.unknownKeys,
      catchall: merging._def.catchall,
      shape: () => ({
        ...this._def.shape(),
        ...merging._def.shape()
      }),
      typeName: ZodFirstPartyTypeKind.ZodObject
    });
    return merged;
  }
  // merge<
  //   Incoming extends AnyZodObject,
  //   Augmentation extends Incoming["shape"],
  //   NewOutput extends {
  //     [k in keyof Augmentation | keyof Output]: k extends keyof Augmentation
  //       ? Augmentation[k]["_output"]
  //       : k extends keyof Output
  //       ? Output[k]
  //       : never;
  //   },
  //   NewInput extends {
  //     [k in keyof Augmentation | keyof Input]: k extends keyof Augmentation
  //       ? Augmentation[k]["_input"]
  //       : k extends keyof Input
  //       ? Input[k]
  //       : never;
  //   }
  // >(
  //   merging: Incoming
  // ): ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"],
  //   NewOutput,
  //   NewInput
  // > {
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  setKey(key, schema) {
    return this.augment({ [key]: schema });
  }
  // merge<Incoming extends AnyZodObject>(
  //   merging: Incoming
  // ): //ZodObject<T & Incoming["_shape"], UnknownKeys, Catchall> = (merging) => {
  // ZodObject<
  //   extendShape<T, ReturnType<Incoming["_def"]["shape"]>>,
  //   Incoming["_def"]["unknownKeys"],
  //   Incoming["_def"]["catchall"]
  // > {
  //   // const mergedShape = objectUtil.mergeShapes(
  //   //   this._def.shape(),
  //   //   merging._def.shape()
  //   // );
  //   const merged: any = new ZodObject({
  //     unknownKeys: merging._def.unknownKeys,
  //     catchall: merging._def.catchall,
  //     shape: () =>
  //       objectUtil.mergeShapes(this._def.shape(), merging._def.shape()),
  //     typeName: ZodFirstPartyTypeKind.ZodObject,
  //   }) as any;
  //   return merged;
  // }
  catchall(index) {
    return new _ZodObject({
      ...this._def,
      catchall: index
    });
  }
  pick(mask) {
    const shape = {};
    for (const key of util.objectKeys(mask)) {
      if (mask[key] && this.shape[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  omit(mask) {
    const shape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (!mask[key]) {
        shape[key] = this.shape[key];
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => shape
    });
  }
  /**
   * @deprecated
   */
  deepPartial() {
    return deepPartialify(this);
  }
  partial(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      const fieldSchema = this.shape[key];
      if (mask && !mask[key]) {
        newShape[key] = fieldSchema;
      } else {
        newShape[key] = fieldSchema.optional();
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  required(mask) {
    const newShape = {};
    for (const key of util.objectKeys(this.shape)) {
      if (mask && !mask[key]) {
        newShape[key] = this.shape[key];
      } else {
        const fieldSchema = this.shape[key];
        let newField = fieldSchema;
        while (newField instanceof ZodOptional) {
          newField = newField._def.innerType;
        }
        newShape[key] = newField;
      }
    }
    return new _ZodObject({
      ...this._def,
      shape: () => newShape
    });
  }
  keyof() {
    return createZodEnum(util.objectKeys(this.shape));
  }
};
ZodObject.create = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.strictCreate = (shape, params) => {
  return new ZodObject({
    shape: () => shape,
    unknownKeys: "strict",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
ZodObject.lazycreate = (shape, params) => {
  return new ZodObject({
    shape,
    unknownKeys: "strip",
    catchall: ZodNever.create(),
    typeName: ZodFirstPartyTypeKind.ZodObject,
    ...processCreateParams(params)
  });
};
var ZodUnion = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const options = this._def.options;
    function handleResults(results) {
      for (const result of results) {
        if (result.result.status === "valid") {
          return result.result;
        }
      }
      for (const result of results) {
        if (result.result.status === "dirty") {
          ctx.common.issues.push(...result.ctx.common.issues);
          return result.result;
        }
      }
      const unionErrors = results.map((result) => new ZodError(result.ctx.common.issues));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return Promise.all(options.map(async (option) => {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        return {
          result: await option._parseAsync({
            data: ctx.data,
            path: ctx.path,
            parent: childCtx
          }),
          ctx: childCtx
        };
      })).then(handleResults);
    } else {
      let dirty = void 0;
      const issues = [];
      for (const option of options) {
        const childCtx = {
          ...ctx,
          common: {
            ...ctx.common,
            issues: []
          },
          parent: null
        };
        const result = option._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: childCtx
        });
        if (result.status === "valid") {
          return result;
        } else if (result.status === "dirty" && !dirty) {
          dirty = { result, ctx: childCtx };
        }
        if (childCtx.common.issues.length) {
          issues.push(childCtx.common.issues);
        }
      }
      if (dirty) {
        ctx.common.issues.push(...dirty.ctx.common.issues);
        return dirty.result;
      }
      const unionErrors = issues.map((issues2) => new ZodError(issues2));
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union,
        unionErrors
      });
      return INVALID;
    }
  }
  get options() {
    return this._def.options;
  }
};
ZodUnion.create = (types, params) => {
  return new ZodUnion({
    options: types,
    typeName: ZodFirstPartyTypeKind.ZodUnion,
    ...processCreateParams(params)
  });
};
var getDiscriminator = (type) => {
  if (type instanceof ZodLazy) {
    return getDiscriminator(type.schema);
  } else if (type instanceof ZodEffects) {
    return getDiscriminator(type.innerType());
  } else if (type instanceof ZodLiteral) {
    return [type.value];
  } else if (type instanceof ZodEnum) {
    return type.options;
  } else if (type instanceof ZodNativeEnum) {
    return util.objectValues(type.enum);
  } else if (type instanceof ZodDefault) {
    return getDiscriminator(type._def.innerType);
  } else if (type instanceof ZodUndefined) {
    return [void 0];
  } else if (type instanceof ZodNull) {
    return [null];
  } else if (type instanceof ZodOptional) {
    return [void 0, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodNullable) {
    return [null, ...getDiscriminator(type.unwrap())];
  } else if (type instanceof ZodBranded) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodReadonly) {
    return getDiscriminator(type.unwrap());
  } else if (type instanceof ZodCatch) {
    return getDiscriminator(type._def.innerType);
  } else {
    return [];
  }
};
var ZodDiscriminatedUnion = class _ZodDiscriminatedUnion extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const discriminator = this.discriminator;
    const discriminatorValue = ctx.data[discriminator];
    const option = this.optionsMap.get(discriminatorValue);
    if (!option) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_union_discriminator,
        options: Array.from(this.optionsMap.keys()),
        path: [discriminator]
      });
      return INVALID;
    }
    if (ctx.common.async) {
      return option._parseAsync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    } else {
      return option._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
    }
  }
  get discriminator() {
    return this._def.discriminator;
  }
  get options() {
    return this._def.options;
  }
  get optionsMap() {
    return this._def.optionsMap;
  }
  /**
   * The constructor of the discriminated union schema. Its behaviour is very similar to that of the normal z.union() constructor.
   * However, it only allows a union of objects, all of which need to share a discriminator property. This property must
   * have a different value for each object in the union.
   * @param discriminator the name of the discriminator property
   * @param types an array of object schemas
   * @param params
   */
  static create(discriminator, options, params) {
    const optionsMap = /* @__PURE__ */ new Map();
    for (const type of options) {
      const discriminatorValues = getDiscriminator(type.shape[discriminator]);
      if (!discriminatorValues.length) {
        throw new Error(`A discriminator value for key \`${discriminator}\` could not be extracted from all schema options`);
      }
      for (const value of discriminatorValues) {
        if (optionsMap.has(value)) {
          throw new Error(`Discriminator property ${String(discriminator)} has duplicate value ${String(value)}`);
        }
        optionsMap.set(value, type);
      }
    }
    return new _ZodDiscriminatedUnion({
      typeName: ZodFirstPartyTypeKind.ZodDiscriminatedUnion,
      discriminator,
      options,
      optionsMap,
      ...processCreateParams(params)
    });
  }
};
function mergeValues(a, b) {
  const aType = getParsedType(a);
  const bType = getParsedType(b);
  if (a === b) {
    return { valid: true, data: a };
  } else if (aType === ZodParsedType.object && bType === ZodParsedType.object) {
    const bKeys = util.objectKeys(b);
    const sharedKeys = util.objectKeys(a).filter((key) => bKeys.indexOf(key) !== -1);
    const newObj = { ...a, ...b };
    for (const key of sharedKeys) {
      const sharedValue = mergeValues(a[key], b[key]);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newObj[key] = sharedValue.data;
    }
    return { valid: true, data: newObj };
  } else if (aType === ZodParsedType.array && bType === ZodParsedType.array) {
    if (a.length !== b.length) {
      return { valid: false };
    }
    const newArray = [];
    for (let index = 0; index < a.length; index++) {
      const itemA = a[index];
      const itemB = b[index];
      const sharedValue = mergeValues(itemA, itemB);
      if (!sharedValue.valid) {
        return { valid: false };
      }
      newArray.push(sharedValue.data);
    }
    return { valid: true, data: newArray };
  } else if (aType === ZodParsedType.date && bType === ZodParsedType.date && +a === +b) {
    return { valid: true, data: a };
  } else {
    return { valid: false };
  }
}
var ZodIntersection = class extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const handleParsed = (parsedLeft, parsedRight) => {
      if (isAborted(parsedLeft) || isAborted(parsedRight)) {
        return INVALID;
      }
      const merged = mergeValues(parsedLeft.value, parsedRight.value);
      if (!merged.valid) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.invalid_intersection_types
        });
        return INVALID;
      }
      if (isDirty(parsedLeft) || isDirty(parsedRight)) {
        status.dirty();
      }
      return { status: status.value, value: merged.data };
    };
    if (ctx.common.async) {
      return Promise.all([
        this._def.left._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        }),
        this._def.right._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        })
      ]).then(([left, right]) => handleParsed(left, right));
    } else {
      return handleParsed(this._def.left._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }), this._def.right._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      }));
    }
  }
};
ZodIntersection.create = (left, right, params) => {
  return new ZodIntersection({
    left,
    right,
    typeName: ZodFirstPartyTypeKind.ZodIntersection,
    ...processCreateParams(params)
  });
};
var ZodTuple = class _ZodTuple extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.array) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.array,
        received: ctx.parsedType
      });
      return INVALID;
    }
    if (ctx.data.length < this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_small,
        minimum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      return INVALID;
    }
    const rest = this._def.rest;
    if (!rest && ctx.data.length > this._def.items.length) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.too_big,
        maximum: this._def.items.length,
        inclusive: true,
        exact: false,
        type: "array"
      });
      status.dirty();
    }
    const items = [...ctx.data].map((item, itemIndex) => {
      const schema = this._def.items[itemIndex] || this._def.rest;
      if (!schema)
        return null;
      return schema._parse(new ParseInputLazyPath(ctx, item, ctx.path, itemIndex));
    }).filter((x) => !!x);
    if (ctx.common.async) {
      return Promise.all(items).then((results) => {
        return ParseStatus.mergeArray(status, results);
      });
    } else {
      return ParseStatus.mergeArray(status, items);
    }
  }
  get items() {
    return this._def.items;
  }
  rest(rest) {
    return new _ZodTuple({
      ...this._def,
      rest
    });
  }
};
ZodTuple.create = (schemas, params) => {
  if (!Array.isArray(schemas)) {
    throw new Error("You must pass an array of schemas to z.tuple([ ... ])");
  }
  return new ZodTuple({
    items: schemas,
    typeName: ZodFirstPartyTypeKind.ZodTuple,
    rest: null,
    ...processCreateParams(params)
  });
};
var ZodRecord = class _ZodRecord extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.object) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.object,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const pairs = [];
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    for (const key in ctx.data) {
      pairs.push({
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, key)),
        value: valueType._parse(new ParseInputLazyPath(ctx, ctx.data[key], ctx.path, key)),
        alwaysSet: key in ctx.data
      });
    }
    if (ctx.common.async) {
      return ParseStatus.mergeObjectAsync(status, pairs);
    } else {
      return ParseStatus.mergeObjectSync(status, pairs);
    }
  }
  get element() {
    return this._def.valueType;
  }
  static create(first, second, third) {
    if (second instanceof ZodType) {
      return new _ZodRecord({
        keyType: first,
        valueType: second,
        typeName: ZodFirstPartyTypeKind.ZodRecord,
        ...processCreateParams(third)
      });
    }
    return new _ZodRecord({
      keyType: ZodString.create(),
      valueType: first,
      typeName: ZodFirstPartyTypeKind.ZodRecord,
      ...processCreateParams(second)
    });
  }
};
var ZodMap = class extends ZodType {
  get keySchema() {
    return this._def.keyType;
  }
  get valueSchema() {
    return this._def.valueType;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.map) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.map,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const keyType = this._def.keyType;
    const valueType = this._def.valueType;
    const pairs = [...ctx.data.entries()].map(([key, value], index) => {
      return {
        key: keyType._parse(new ParseInputLazyPath(ctx, key, ctx.path, [index, "key"])),
        value: valueType._parse(new ParseInputLazyPath(ctx, value, ctx.path, [index, "value"]))
      };
    });
    if (ctx.common.async) {
      const finalMap = /* @__PURE__ */ new Map();
      return Promise.resolve().then(async () => {
        for (const pair of pairs) {
          const key = await pair.key;
          const value = await pair.value;
          if (key.status === "aborted" || value.status === "aborted") {
            return INVALID;
          }
          if (key.status === "dirty" || value.status === "dirty") {
            status.dirty();
          }
          finalMap.set(key.value, value.value);
        }
        return { status: status.value, value: finalMap };
      });
    } else {
      const finalMap = /* @__PURE__ */ new Map();
      for (const pair of pairs) {
        const key = pair.key;
        const value = pair.value;
        if (key.status === "aborted" || value.status === "aborted") {
          return INVALID;
        }
        if (key.status === "dirty" || value.status === "dirty") {
          status.dirty();
        }
        finalMap.set(key.value, value.value);
      }
      return { status: status.value, value: finalMap };
    }
  }
};
ZodMap.create = (keyType, valueType, params) => {
  return new ZodMap({
    valueType,
    keyType,
    typeName: ZodFirstPartyTypeKind.ZodMap,
    ...processCreateParams(params)
  });
};
var ZodSet = class _ZodSet extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.set) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.set,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const def = this._def;
    if (def.minSize !== null) {
      if (ctx.data.size < def.minSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_small,
          minimum: def.minSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.minSize.message
        });
        status.dirty();
      }
    }
    if (def.maxSize !== null) {
      if (ctx.data.size > def.maxSize.value) {
        addIssueToContext(ctx, {
          code: ZodIssueCode.too_big,
          maximum: def.maxSize.value,
          type: "set",
          inclusive: true,
          exact: false,
          message: def.maxSize.message
        });
        status.dirty();
      }
    }
    const valueType = this._def.valueType;
    function finalizeSet(elements2) {
      const parsedSet = /* @__PURE__ */ new Set();
      for (const element of elements2) {
        if (element.status === "aborted")
          return INVALID;
        if (element.status === "dirty")
          status.dirty();
        parsedSet.add(element.value);
      }
      return { status: status.value, value: parsedSet };
    }
    const elements = [...ctx.data.values()].map((item, i) => valueType._parse(new ParseInputLazyPath(ctx, item, ctx.path, i)));
    if (ctx.common.async) {
      return Promise.all(elements).then((elements2) => finalizeSet(elements2));
    } else {
      return finalizeSet(elements);
    }
  }
  min(minSize, message) {
    return new _ZodSet({
      ...this._def,
      minSize: { value: minSize, message: errorUtil.toString(message) }
    });
  }
  max(maxSize, message) {
    return new _ZodSet({
      ...this._def,
      maxSize: { value: maxSize, message: errorUtil.toString(message) }
    });
  }
  size(size, message) {
    return this.min(size, message).max(size, message);
  }
  nonempty(message) {
    return this.min(1, message);
  }
};
ZodSet.create = (valueType, params) => {
  return new ZodSet({
    valueType,
    minSize: null,
    maxSize: null,
    typeName: ZodFirstPartyTypeKind.ZodSet,
    ...processCreateParams(params)
  });
};
var ZodFunction = class _ZodFunction extends ZodType {
  constructor() {
    super(...arguments);
    this.validate = this.implement;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.function) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.function,
        received: ctx.parsedType
      });
      return INVALID;
    }
    function makeArgsIssue(args, error) {
      return makeIssue({
        data: args,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_arguments,
          argumentsError: error
        }
      });
    }
    function makeReturnsIssue(returns, error) {
      return makeIssue({
        data: returns,
        path: ctx.path,
        errorMaps: [ctx.common.contextualErrorMap, ctx.schemaErrorMap, getErrorMap(), en_default].filter((x) => !!x),
        issueData: {
          code: ZodIssueCode.invalid_return_type,
          returnTypeError: error
        }
      });
    }
    const params = { errorMap: ctx.common.contextualErrorMap };
    const fn = ctx.data;
    if (this._def.returns instanceof ZodPromise) {
      const me = this;
      return OK(async function(...args) {
        const error = new ZodError([]);
        const parsedArgs = await me._def.args.parseAsync(args, params).catch((e) => {
          error.addIssue(makeArgsIssue(args, e));
          throw error;
        });
        const result = await Reflect.apply(fn, this, parsedArgs);
        const parsedReturns = await me._def.returns._def.type.parseAsync(result, params).catch((e) => {
          error.addIssue(makeReturnsIssue(result, e));
          throw error;
        });
        return parsedReturns;
      });
    } else {
      const me = this;
      return OK(function(...args) {
        const parsedArgs = me._def.args.safeParse(args, params);
        if (!parsedArgs.success) {
          throw new ZodError([makeArgsIssue(args, parsedArgs.error)]);
        }
        const result = Reflect.apply(fn, this, parsedArgs.data);
        const parsedReturns = me._def.returns.safeParse(result, params);
        if (!parsedReturns.success) {
          throw new ZodError([makeReturnsIssue(result, parsedReturns.error)]);
        }
        return parsedReturns.data;
      });
    }
  }
  parameters() {
    return this._def.args;
  }
  returnType() {
    return this._def.returns;
  }
  args(...items) {
    return new _ZodFunction({
      ...this._def,
      args: ZodTuple.create(items).rest(ZodUnknown.create())
    });
  }
  returns(returnType) {
    return new _ZodFunction({
      ...this._def,
      returns: returnType
    });
  }
  implement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  strictImplement(func) {
    const validatedFunc = this.parse(func);
    return validatedFunc;
  }
  static create(args, returns, params) {
    return new _ZodFunction({
      args: args ? args : ZodTuple.create([]).rest(ZodUnknown.create()),
      returns: returns || ZodUnknown.create(),
      typeName: ZodFirstPartyTypeKind.ZodFunction,
      ...processCreateParams(params)
    });
  }
};
var ZodLazy = class extends ZodType {
  get schema() {
    return this._def.getter();
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const lazySchema = this._def.getter();
    return lazySchema._parse({ data: ctx.data, path: ctx.path, parent: ctx });
  }
};
ZodLazy.create = (getter, params) => {
  return new ZodLazy({
    getter,
    typeName: ZodFirstPartyTypeKind.ZodLazy,
    ...processCreateParams(params)
  });
};
var ZodLiteral = class extends ZodType {
  _parse(input) {
    if (input.data !== this._def.value) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_literal,
        expected: this._def.value
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
  get value() {
    return this._def.value;
  }
};
ZodLiteral.create = (value, params) => {
  return new ZodLiteral({
    value,
    typeName: ZodFirstPartyTypeKind.ZodLiteral,
    ...processCreateParams(params)
  });
};
function createZodEnum(values, params) {
  return new ZodEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodEnum,
    ...processCreateParams(params)
  });
}
var ZodEnum = class _ZodEnum extends ZodType {
  _parse(input) {
    if (typeof input.data !== "string") {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(this._def.values);
    }
    if (!this._cache.has(input.data)) {
      const ctx = this._getOrReturnCtx(input);
      const expectedValues = this._def.values;
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get options() {
    return this._def.values;
  }
  get enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Values() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  get Enum() {
    const enumValues = {};
    for (const val of this._def.values) {
      enumValues[val] = val;
    }
    return enumValues;
  }
  extract(values, newDef = this._def) {
    return _ZodEnum.create(values, {
      ...this._def,
      ...newDef
    });
  }
  exclude(values, newDef = this._def) {
    return _ZodEnum.create(this.options.filter((opt) => !values.includes(opt)), {
      ...this._def,
      ...newDef
    });
  }
};
ZodEnum.create = createZodEnum;
var ZodNativeEnum = class extends ZodType {
  _parse(input) {
    const nativeEnumValues = util.getValidEnumValues(this._def.values);
    const ctx = this._getOrReturnCtx(input);
    if (ctx.parsedType !== ZodParsedType.string && ctx.parsedType !== ZodParsedType.number) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        expected: util.joinValues(expectedValues),
        received: ctx.parsedType,
        code: ZodIssueCode.invalid_type
      });
      return INVALID;
    }
    if (!this._cache) {
      this._cache = new Set(util.getValidEnumValues(this._def.values));
    }
    if (!this._cache.has(input.data)) {
      const expectedValues = util.objectValues(nativeEnumValues);
      addIssueToContext(ctx, {
        received: ctx.data,
        code: ZodIssueCode.invalid_enum_value,
        options: expectedValues
      });
      return INVALID;
    }
    return OK(input.data);
  }
  get enum() {
    return this._def.values;
  }
};
ZodNativeEnum.create = (values, params) => {
  return new ZodNativeEnum({
    values,
    typeName: ZodFirstPartyTypeKind.ZodNativeEnum,
    ...processCreateParams(params)
  });
};
var ZodPromise = class extends ZodType {
  unwrap() {
    return this._def.type;
  }
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    if (ctx.parsedType !== ZodParsedType.promise && ctx.common.async === false) {
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.promise,
        received: ctx.parsedType
      });
      return INVALID;
    }
    const promisified = ctx.parsedType === ZodParsedType.promise ? ctx.data : Promise.resolve(ctx.data);
    return OK(promisified.then((data) => {
      return this._def.type.parseAsync(data, {
        path: ctx.path,
        errorMap: ctx.common.contextualErrorMap
      });
    }));
  }
};
ZodPromise.create = (schema, params) => {
  return new ZodPromise({
    type: schema,
    typeName: ZodFirstPartyTypeKind.ZodPromise,
    ...processCreateParams(params)
  });
};
var ZodEffects = class extends ZodType {
  innerType() {
    return this._def.schema;
  }
  sourceType() {
    return this._def.schema._def.typeName === ZodFirstPartyTypeKind.ZodEffects ? this._def.schema.sourceType() : this._def.schema;
  }
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    const effect = this._def.effect || null;
    const checkCtx = {
      addIssue: (arg) => {
        addIssueToContext(ctx, arg);
        if (arg.fatal) {
          status.abort();
        } else {
          status.dirty();
        }
      },
      get path() {
        return ctx.path;
      }
    };
    checkCtx.addIssue = checkCtx.addIssue.bind(checkCtx);
    if (effect.type === "preprocess") {
      const processed = effect.transform(ctx.data, checkCtx);
      if (ctx.common.async) {
        return Promise.resolve(processed).then(async (processed2) => {
          if (status.value === "aborted")
            return INVALID;
          const result = await this._def.schema._parseAsync({
            data: processed2,
            path: ctx.path,
            parent: ctx
          });
          if (result.status === "aborted")
            return INVALID;
          if (result.status === "dirty")
            return DIRTY(result.value);
          if (status.value === "dirty")
            return DIRTY(result.value);
          return result;
        });
      } else {
        if (status.value === "aborted")
          return INVALID;
        const result = this._def.schema._parseSync({
          data: processed,
          path: ctx.path,
          parent: ctx
        });
        if (result.status === "aborted")
          return INVALID;
        if (result.status === "dirty")
          return DIRTY(result.value);
        if (status.value === "dirty")
          return DIRTY(result.value);
        return result;
      }
    }
    if (effect.type === "refinement") {
      const executeRefinement = (acc) => {
        const result = effect.refinement(acc, checkCtx);
        if (ctx.common.async) {
          return Promise.resolve(result);
        }
        if (result instanceof Promise) {
          throw new Error("Async refinement encountered during synchronous parse operation. Use .parseAsync instead.");
        }
        return acc;
      };
      if (ctx.common.async === false) {
        const inner = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inner.status === "aborted")
          return INVALID;
        if (inner.status === "dirty")
          status.dirty();
        executeRefinement(inner.value);
        return { status: status.value, value: inner.value };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((inner) => {
          if (inner.status === "aborted")
            return INVALID;
          if (inner.status === "dirty")
            status.dirty();
          return executeRefinement(inner.value).then(() => {
            return { status: status.value, value: inner.value };
          });
        });
      }
    }
    if (effect.type === "transform") {
      if (ctx.common.async === false) {
        const base = this._def.schema._parseSync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (!isValid(base))
          return INVALID;
        const result = effect.transform(base.value, checkCtx);
        if (result instanceof Promise) {
          throw new Error(`Asynchronous transform encountered during synchronous parse operation. Use .parseAsync instead.`);
        }
        return { status: status.value, value: result };
      } else {
        return this._def.schema._parseAsync({ data: ctx.data, path: ctx.path, parent: ctx }).then((base) => {
          if (!isValid(base))
            return INVALID;
          return Promise.resolve(effect.transform(base.value, checkCtx)).then((result) => ({
            status: status.value,
            value: result
          }));
        });
      }
    }
    util.assertNever(effect);
  }
};
ZodEffects.create = (schema, effect, params) => {
  return new ZodEffects({
    schema,
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    effect,
    ...processCreateParams(params)
  });
};
ZodEffects.createWithPreprocess = (preprocess, schema, params) => {
  return new ZodEffects({
    schema,
    effect: { type: "preprocess", transform: preprocess },
    typeName: ZodFirstPartyTypeKind.ZodEffects,
    ...processCreateParams(params)
  });
};
var ZodOptional = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.undefined) {
      return OK(void 0);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodOptional.create = (type, params) => {
  return new ZodOptional({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodOptional,
    ...processCreateParams(params)
  });
};
var ZodNullable = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType === ZodParsedType.null) {
      return OK(null);
    }
    return this._def.innerType._parse(input);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodNullable.create = (type, params) => {
  return new ZodNullable({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodNullable,
    ...processCreateParams(params)
  });
};
var ZodDefault = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    let data = ctx.data;
    if (ctx.parsedType === ZodParsedType.undefined) {
      data = this._def.defaultValue();
    }
    return this._def.innerType._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  removeDefault() {
    return this._def.innerType;
  }
};
ZodDefault.create = (type, params) => {
  return new ZodDefault({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodDefault,
    defaultValue: typeof params.default === "function" ? params.default : () => params.default,
    ...processCreateParams(params)
  });
};
var ZodCatch = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const newCtx = {
      ...ctx,
      common: {
        ...ctx.common,
        issues: []
      }
    };
    const result = this._def.innerType._parse({
      data: newCtx.data,
      path: newCtx.path,
      parent: {
        ...newCtx
      }
    });
    if (isAsync(result)) {
      return result.then((result2) => {
        return {
          status: "valid",
          value: result2.status === "valid" ? result2.value : this._def.catchValue({
            get error() {
              return new ZodError(newCtx.common.issues);
            },
            input: newCtx.data
          })
        };
      });
    } else {
      return {
        status: "valid",
        value: result.status === "valid" ? result.value : this._def.catchValue({
          get error() {
            return new ZodError(newCtx.common.issues);
          },
          input: newCtx.data
        })
      };
    }
  }
  removeCatch() {
    return this._def.innerType;
  }
};
ZodCatch.create = (type, params) => {
  return new ZodCatch({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodCatch,
    catchValue: typeof params.catch === "function" ? params.catch : () => params.catch,
    ...processCreateParams(params)
  });
};
var ZodNaN = class extends ZodType {
  _parse(input) {
    const parsedType = this._getType(input);
    if (parsedType !== ZodParsedType.nan) {
      const ctx = this._getOrReturnCtx(input);
      addIssueToContext(ctx, {
        code: ZodIssueCode.invalid_type,
        expected: ZodParsedType.nan,
        received: ctx.parsedType
      });
      return INVALID;
    }
    return { status: "valid", value: input.data };
  }
};
ZodNaN.create = (params) => {
  return new ZodNaN({
    typeName: ZodFirstPartyTypeKind.ZodNaN,
    ...processCreateParams(params)
  });
};
var BRAND = /* @__PURE__ */ Symbol("zod_brand");
var ZodBranded = class extends ZodType {
  _parse(input) {
    const { ctx } = this._processInputParams(input);
    const data = ctx.data;
    return this._def.type._parse({
      data,
      path: ctx.path,
      parent: ctx
    });
  }
  unwrap() {
    return this._def.type;
  }
};
var ZodPipeline = class _ZodPipeline extends ZodType {
  _parse(input) {
    const { status, ctx } = this._processInputParams(input);
    if (ctx.common.async) {
      const handleAsync = async () => {
        const inResult = await this._def.in._parseAsync({
          data: ctx.data,
          path: ctx.path,
          parent: ctx
        });
        if (inResult.status === "aborted")
          return INVALID;
        if (inResult.status === "dirty") {
          status.dirty();
          return DIRTY(inResult.value);
        } else {
          return this._def.out._parseAsync({
            data: inResult.value,
            path: ctx.path,
            parent: ctx
          });
        }
      };
      return handleAsync();
    } else {
      const inResult = this._def.in._parseSync({
        data: ctx.data,
        path: ctx.path,
        parent: ctx
      });
      if (inResult.status === "aborted")
        return INVALID;
      if (inResult.status === "dirty") {
        status.dirty();
        return {
          status: "dirty",
          value: inResult.value
        };
      } else {
        return this._def.out._parseSync({
          data: inResult.value,
          path: ctx.path,
          parent: ctx
        });
      }
    }
  }
  static create(a, b) {
    return new _ZodPipeline({
      in: a,
      out: b,
      typeName: ZodFirstPartyTypeKind.ZodPipeline
    });
  }
};
var ZodReadonly = class extends ZodType {
  _parse(input) {
    const result = this._def.innerType._parse(input);
    const freeze = (data) => {
      if (isValid(data)) {
        data.value = Object.freeze(data.value);
      }
      return data;
    };
    return isAsync(result) ? result.then((data) => freeze(data)) : freeze(result);
  }
  unwrap() {
    return this._def.innerType;
  }
};
ZodReadonly.create = (type, params) => {
  return new ZodReadonly({
    innerType: type,
    typeName: ZodFirstPartyTypeKind.ZodReadonly,
    ...processCreateParams(params)
  });
};
function cleanParams(params, data) {
  const p = typeof params === "function" ? params(data) : typeof params === "string" ? { message: params } : params;
  const p2 = typeof p === "string" ? { message: p } : p;
  return p2;
}
function custom(check, _params = {}, fatal) {
  if (check)
    return ZodAny.create().superRefine((data, ctx) => {
      const r = check(data);
      if (r instanceof Promise) {
        return r.then((r2) => {
          if (!r2) {
            const params = cleanParams(_params, data);
            const _fatal = params.fatal ?? fatal ?? true;
            ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
          }
        });
      }
      if (!r) {
        const params = cleanParams(_params, data);
        const _fatal = params.fatal ?? fatal ?? true;
        ctx.addIssue({ code: "custom", ...params, fatal: _fatal });
      }
      return;
    });
  return ZodAny.create();
}
var late = {
  object: ZodObject.lazycreate
};
var ZodFirstPartyTypeKind;
(function(ZodFirstPartyTypeKind2) {
  ZodFirstPartyTypeKind2["ZodString"] = "ZodString";
  ZodFirstPartyTypeKind2["ZodNumber"] = "ZodNumber";
  ZodFirstPartyTypeKind2["ZodNaN"] = "ZodNaN";
  ZodFirstPartyTypeKind2["ZodBigInt"] = "ZodBigInt";
  ZodFirstPartyTypeKind2["ZodBoolean"] = "ZodBoolean";
  ZodFirstPartyTypeKind2["ZodDate"] = "ZodDate";
  ZodFirstPartyTypeKind2["ZodSymbol"] = "ZodSymbol";
  ZodFirstPartyTypeKind2["ZodUndefined"] = "ZodUndefined";
  ZodFirstPartyTypeKind2["ZodNull"] = "ZodNull";
  ZodFirstPartyTypeKind2["ZodAny"] = "ZodAny";
  ZodFirstPartyTypeKind2["ZodUnknown"] = "ZodUnknown";
  ZodFirstPartyTypeKind2["ZodNever"] = "ZodNever";
  ZodFirstPartyTypeKind2["ZodVoid"] = "ZodVoid";
  ZodFirstPartyTypeKind2["ZodArray"] = "ZodArray";
  ZodFirstPartyTypeKind2["ZodObject"] = "ZodObject";
  ZodFirstPartyTypeKind2["ZodUnion"] = "ZodUnion";
  ZodFirstPartyTypeKind2["ZodDiscriminatedUnion"] = "ZodDiscriminatedUnion";
  ZodFirstPartyTypeKind2["ZodIntersection"] = "ZodIntersection";
  ZodFirstPartyTypeKind2["ZodTuple"] = "ZodTuple";
  ZodFirstPartyTypeKind2["ZodRecord"] = "ZodRecord";
  ZodFirstPartyTypeKind2["ZodMap"] = "ZodMap";
  ZodFirstPartyTypeKind2["ZodSet"] = "ZodSet";
  ZodFirstPartyTypeKind2["ZodFunction"] = "ZodFunction";
  ZodFirstPartyTypeKind2["ZodLazy"] = "ZodLazy";
  ZodFirstPartyTypeKind2["ZodLiteral"] = "ZodLiteral";
  ZodFirstPartyTypeKind2["ZodEnum"] = "ZodEnum";
  ZodFirstPartyTypeKind2["ZodEffects"] = "ZodEffects";
  ZodFirstPartyTypeKind2["ZodNativeEnum"] = "ZodNativeEnum";
  ZodFirstPartyTypeKind2["ZodOptional"] = "ZodOptional";
  ZodFirstPartyTypeKind2["ZodNullable"] = "ZodNullable";
  ZodFirstPartyTypeKind2["ZodDefault"] = "ZodDefault";
  ZodFirstPartyTypeKind2["ZodCatch"] = "ZodCatch";
  ZodFirstPartyTypeKind2["ZodPromise"] = "ZodPromise";
  ZodFirstPartyTypeKind2["ZodBranded"] = "ZodBranded";
  ZodFirstPartyTypeKind2["ZodPipeline"] = "ZodPipeline";
  ZodFirstPartyTypeKind2["ZodReadonly"] = "ZodReadonly";
})(ZodFirstPartyTypeKind || (ZodFirstPartyTypeKind = {}));
var instanceOfType = (cls, params = {
  message: `Input not instance of ${cls.name}`
}) => custom((data) => data instanceof cls, params);
var stringType = ZodString.create;
var numberType = ZodNumber.create;
var nanType = ZodNaN.create;
var bigIntType = ZodBigInt.create;
var booleanType = ZodBoolean.create;
var dateType = ZodDate.create;
var symbolType = ZodSymbol.create;
var undefinedType = ZodUndefined.create;
var nullType = ZodNull.create;
var anyType = ZodAny.create;
var unknownType = ZodUnknown.create;
var neverType = ZodNever.create;
var voidType = ZodVoid.create;
var arrayType = ZodArray.create;
var objectType = ZodObject.create;
var strictObjectType = ZodObject.strictCreate;
var unionType = ZodUnion.create;
var discriminatedUnionType = ZodDiscriminatedUnion.create;
var intersectionType = ZodIntersection.create;
var tupleType = ZodTuple.create;
var recordType = ZodRecord.create;
var mapType = ZodMap.create;
var setType = ZodSet.create;
var functionType = ZodFunction.create;
var lazyType = ZodLazy.create;
var literalType = ZodLiteral.create;
var enumType = ZodEnum.create;
var nativeEnumType = ZodNativeEnum.create;
var promiseType = ZodPromise.create;
var effectsType = ZodEffects.create;
var optionalType = ZodOptional.create;
var nullableType = ZodNullable.create;
var preprocessType = ZodEffects.createWithPreprocess;
var pipelineType = ZodPipeline.create;
var ostring = () => stringType().optional();
var onumber = () => numberType().optional();
var oboolean = () => booleanType().optional();
var coerce = {
  string: ((arg) => ZodString.create({ ...arg, coerce: true })),
  number: ((arg) => ZodNumber.create({ ...arg, coerce: true })),
  boolean: ((arg) => ZodBoolean.create({
    ...arg,
    coerce: true
  })),
  bigint: ((arg) => ZodBigInt.create({ ...arg, coerce: true })),
  date: ((arg) => ZodDate.create({ ...arg, coerce: true }))
};
var NEVER = INVALID;

// src/lib/settings.ts
import { homedir as homedir2 } from "node:os";
import { join as join3 } from "node:path";

// src/lib/account-pool.ts
var BACKOFF = { baseMs: 5e3, maxMs: 2 * 60 * 1e3, maxLevel: 15 };
var QUOTA_FALLBACK_COOLDOWN_MS = 15 * 60 * 1e3;
var MAX_HINT_COOLDOWN_MS = 8 * 60 * 60 * 1e3;

// src/lib/settings.ts
var GATE_DIR = process.env.GATE_HOME || join3(homedir2(), ".gate");
var FILE = join3(GATE_DIR, "settings.json");

// src/lib/reasoning.ts
var EFFORTS = ["default", "low", "medium", "high", "xhigh", "max"];

// src/agents/types.ts
var FIELD_TYPES = ["string", "number", "boolean", "string[]", "number[]", "object", "object[]", "any"];
var fieldSpec = external_exports.string().refine(
  (s) => FIELD_TYPES.includes(s.replace(/\?$/, "")),
  (s) => ({ message: `unknown field type "${s}" (expected one of ${FIELD_TYPES.join(", ")}, optionally with "?")` })
);
var agentOutputSpecSchema = external_exports.union([
  external_exports.object({ type: external_exports.literal("text") }),
  external_exports.object({ type: external_exports.literal("json"), schema: external_exports.record(external_exports.string().min(1), fieldSpec) })
]);
var agentFrontmatterSchema = external_exports.object({
  name: external_exports.string().min(1).max(64),
  description: external_exports.string().max(500).optional(),
  /** Tier alias ("sonnet"), or a concrete "claude-*" id. Resolved by the existing router. */
  model: external_exports.string().min(1).max(100).default("sonnet"),
  effort: external_exports.enum(EFFORTS).optional(),
  /** Upstream node outputs this agent is allowed to read, e.g. "planner.plan". */
  inputs: external_exports.array(external_exports.string().min(1).max(200)).max(50).default([]),
  output: agentOutputSpecSchema.default({ type: "text" }),
  /**
   * Which loop runs this agent's node.
   *
   * `gate` is the built-in one: gate holds the conversation and serves its own
   * six tools. `claude-code` hands the node to a headless Claude Code in the
   * worktree instead — better tools, and a harness that compacts its context
   * rather than appending every tool result until the node re-reads 100K a
   * round. Routing, metering and the run budget are unaffected either way:
   * the child is pointed at this gate's own gateway.
   */
  executor: external_exports.enum(["gate", "claude-code"]).default("gate"),
  /**
   * Tool names this agent may invoke. Which names are valid depends on the
   * executor: gate's own (`read_file`, `edit_file`, …) or Claude Code's
   * (`Read`, `Edit`, `Grep`, `Bash`, …).
   */
  tools: external_exports.array(external_exports.string().min(1).max(64)).max(50).default([]),
  /**
   * Wall-clock cap on one visit to this agent's node — every tool round it
   * takes counts against it, not each model call separately. Left out, it is
   * an hour, which is past any healthy node; 0 turns it off entirely for an
   * agent that genuinely runs longer. There is no upper bound.
   */
  timeoutMs: external_exports.number().int().min(0).optional(),
  /**
   * Output ceiling per model call. Thinking counts against it, so an agent
   * that must return something long (a full diff) needs a bigger one than
   * the 8192 default.
   */
  maxTokens: external_exports.number().int().min(1024).max(2e5).optional(),
  /**
   * Tool-call rounds a single node may make before the runtime gives up on
   * it. Unset — or 0 — means no cap, which is the default: a long task that
   * reads and edits its way through a large repo for hours legitimately
   * needs more rounds than anyone can name up front, and the timeout above
   * is the real backstop. Set it only to hold a known-cheap agent short.
   */
  maxToolIterations: external_exports.number().int().min(0).optional()
}).strict();
function buildOutputSchema(spec) {
  if (spec.type === "text") return external_exports.string();
  const shape = {};
  for (const [field, raw] of Object.entries(spec.schema)) {
    const optional = raw.endsWith("?");
    const base = fieldValidator(raw.replace(/\?$/, ""));
    shape[field] = optional ? base.optional() : base;
  }
  return external_exports.object(shape).passthrough();
}
function fieldValidator(t) {
  switch (t) {
    case "string":
      return external_exports.string();
    case "number":
      return external_exports.number();
    case "boolean":
      return external_exports.boolean();
    case "string[]":
      return external_exports.array(external_exports.string());
    case "number[]":
      return external_exports.array(external_exports.number());
    // A list of findings is the shape a reviewer reaches for on its own, and
    // without this the vocabulary could say `object` but not a list of them —
    // so the model returned objects, the schema demanded strings, and the node
    // died on the mismatch every single run.
    case "object[]":
      return external_exports.array(external_exports.record(external_exports.string(), external_exports.unknown()));
    case "object":
      return external_exports.record(external_exports.string(), external_exports.unknown());
    default:
      return external_exports.unknown();
  }
}

// src/agents/loader.ts
var AgentDefinitionError = class extends Error {
  constructor(message, agentId) {
    super(message);
    this.agentId = agentId;
  }
  agentId;
};
var FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
function parseAgent(id, raw, meta) {
  const m = FRONTMATTER.exec(raw.replace(/^﻿/, ""));
  if (!m) throw new AgentDefinitionError("missing YAML frontmatter (a file must start with a --- block)", id);
  let front;
  try {
    front = load(m[1]) ?? {};
  } catch (e) {
    throw new AgentDefinitionError(`invalid YAML frontmatter: ${e.message}`, id);
  }
  const parsed = agentFrontmatterSchema.safeParse(front);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new AgentDefinitionError(`invalid frontmatter: ${detail}`, id);
  }
  const prompt = m[2].trim();
  if (!prompt) throw new AgentDefinitionError("prompt body is empty", id);
  const def = { ...parsed.data, id, prompt, sourcePath: meta.sourcePath, updatedAt: meta.updatedAt };
  if (def.executor === "gate") {
    const unknownTools = def.tools.filter((t) => !isKnownTool(t));
    if (unknownTools.length) {
      throw new AgentDefinitionError(
        `unknown tool${unknownTools.length > 1 ? "s" : ""}: ${unknownTools.join(", ")} (available: ${knownToolNames().join(", ")})`,
        id
      );
    }
  }
  assertTemplateInputsDeclared(def);
  return def;
}
function assertTemplateInputsDeclared(def) {
  const declared = new Set(def.inputs.map((i) => i.replace(/\?$/, "")));
  const undeclared = templatePaths(def.prompt).filter((p) => p.startsWith("inputs.")).map((p) => p.slice("inputs.".length)).filter((p) => ![...declared].some((d) => p === d || p.startsWith(`${d}.`) || d.startsWith(`${p}.`)));
  if (undeclared.length) {
    throw new AgentDefinitionError(
      `prompt references undeclared input${undeclared.length > 1 ? "s" : ""}: ${[...new Set(undeclared)].join(", ")}`,
      def.id
    );
  }
}

// src/agents/registry.ts
var ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
function agentsDir(scope = teamScope()) {
  return join4(scope.root, "agents");
}
function pathFor(id, scope) {
  if (!ID_RE.test(id)) throw new AgentDefinitionError("invalid agent id (use lowercase letters, digits and dashes)", id);
  return join4(agentsDir(scope), `${id}.md`);
}
var cache = /* @__PURE__ */ new Map();
function loadFile(id, file) {
  const stat = statSync2(file);
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseAgent(id, readFileSync2(file, "utf8"), { sourcePath: file, updatedAt: stat.mtimeMs });
  cache.set(file, { mtimeMs: stat.mtimeMs, def });
  return def;
}
function listAgents(scope = teamScope()) {
  const dir = agentsDir(scope);
  if (!existsSync3(dir)) return { agents: [], errors: [] };
  const agents = [];
  const errors = [];
  for (const entry of readdirSync2(dir).sort()) {
    if (!entry.endsWith(".md")) continue;
    const id = entry.slice(0, -3);
    try {
      agents.push(loadFile(id, join4(dir, entry)));
    } catch (e) {
      errors.push({ id, message: e.message });
    }
  }
  return { agents, errors };
}
function resolveFile(id, scope) {
  const own = pathFor(id, scope);
  if (existsSync3(own)) return own;
  if (scope.fallback) return resolveFile(id, scope.fallback);
  return null;
}
function getAgent(id, scope = teamScope()) {
  const file = resolveFile(id, scope);
  if (!file) throw new AgentDefinitionError("agent not found", id);
  return loadFile(id, file);
}
function agentExists(id, scope = teamScope()) {
  return resolveFile(id, scope) !== null;
}
function readAgentSource(id, scope = teamScope()) {
  const file = resolveFile(id, scope);
  if (!file) throw new AgentDefinitionError("agent not found", id);
  return readFileSync2(file, "utf8");
}

// src/workflows/registry.ts
import { existsSync as existsSync4, mkdirSync as mkdirSync4, readFileSync as readFileSync3, readdirSync as readdirSync3, rmSync as rmSync2, statSync as statSync3, writeFileSync as writeFileSync3 } from "node:fs";
import { join as join5 } from "node:path";

// src/runtime/errors.ts
var WorkflowError = class extends Error {
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
    this.name = code;
  }
  code;
  detail;
};

// src/workflows/condition.ts
var ConditionError = class extends Error {
};
var OPERATORS = ["==", "!=", ">=", "<=", "&&", "||", ">", "<", "!", "(", ")", "."];
function tokenize(src) {
  const out = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      let s = "";
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === "\\" && i + 1 < src.length) {
          s += src[i + 1];
          i += 2;
          continue;
        }
        s += src[i++];
      }
      if (i >= src.length) throw new ConditionError(`unterminated string in: ${src}`);
      i++;
      out.push({ t: "str", v: s });
      continue;
    }
    if (/[0-9]/.test(c)) {
      let s = "";
      while (i < src.length && /[0-9._]/.test(src[i])) s += src[i++];
      const n = Number(s.replace(/_/g, ""));
      if (Number.isNaN(n)) throw new ConditionError(`invalid number "${s}"`);
      out.push({ t: "num", v: n });
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let s = "";
      while (i < src.length && /[A-Za-z0-9_-]/.test(src[i])) s += src[i++];
      out.push({ t: "ident", v: s });
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new ConditionError(`unexpected character "${c}" in: ${src}`);
    i += op.length;
    out.push({ t: "op", v: op });
  }
  return out;
}
var Parser = class {
  constructor(toks, src) {
    this.toks = toks;
    this.src = src;
  }
  toks;
  src;
  pos = 0;
  parse() {
    const node = this.or();
    if (this.pos < this.toks.length) throw new ConditionError(`trailing input in: ${this.src}`);
    return node;
  }
  peek() {
    return this.toks[this.pos];
  }
  eatOp(...ops) {
    const t = this.peek();
    if (t?.t === "op" && ops.includes(t.v)) {
      this.pos++;
      return t.v;
    }
    return null;
  }
  or() {
    let left = this.and();
    while (this.eatOp("||")) left = { kind: "binary", op: "||", left, right: this.and() };
    return left;
  }
  and() {
    let left = this.comparison();
    while (this.eatOp("&&")) left = { kind: "binary", op: "&&", left, right: this.comparison() };
    return left;
  }
  comparison() {
    const left = this.unary();
    const op = this.eatOp("==", "!=", ">=", "<=", ">", "<");
    if (!op) return left;
    return { kind: "binary", op, left, right: this.unary() };
  }
  unary() {
    if (this.eatOp("!")) return { kind: "not", expr: this.unary() };
    return this.primary();
  }
  primary() {
    const t = this.peek();
    if (!t) throw new ConditionError(`unexpected end of expression: ${this.src}`);
    if (t.t === "op" && t.v === "(") {
      this.pos++;
      const inner = this.or();
      if (!this.eatOp(")")) throw new ConditionError(`missing ")" in: ${this.src}`);
      return inner;
    }
    if (t.t === "num") {
      this.pos++;
      return { kind: "literal", value: t.v };
    }
    if (t.t === "str") {
      this.pos++;
      return { kind: "literal", value: t.v };
    }
    if (t.t === "ident") {
      this.pos++;
      if (t.v === "true") return { kind: "literal", value: true };
      if (t.v === "false") return { kind: "literal", value: false };
      if (t.v === "null") return { kind: "literal", value: null };
      const path = [t.v];
      while (this.eatOp(".")) {
        const seg = this.peek();
        if (seg?.t !== "ident") throw new ConditionError(`expected a name after "." in: ${this.src}`);
        this.pos++;
        path.push(seg.v);
      }
      return { kind: "path", path };
    }
    throw new ConditionError(`unexpected token "${t.v}" in: ${this.src}`);
  }
};
function parseCondition(src) {
  if (!src.trim()) throw new ConditionError("empty condition");
  return new Parser(tokenize(src), src).parse();
}
function conditionPaths(node) {
  switch (node.kind) {
    case "path":
      return [node.path];
    case "not":
    case "neg":
      return conditionPaths(node.expr);
    case "binary":
      return [...conditionPaths(node.left), ...conditionPaths(node.right)];
    default:
      return [];
  }
}
function lookup2(path, ctx) {
  let cur = ctx;
  for (const seg of path) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[seg];
  }
  return cur;
}
function truthy(v) {
  return Boolean(v);
}
function evalNode(node, ctx) {
  switch (node.kind) {
    case "literal":
      return node.value;
    case "path": {
      const v = lookup2(node.path, ctx);
      return v === void 0 && node.path[0] === "visits" ? 0 : v;
    }
    case "not":
      return !truthy(evalNode(node.expr, ctx));
    case "neg": {
      const v = evalNode(node.expr, ctx);
      if (typeof v !== "number") throw new ConditionError("unary minus needs a number");
      return -v;
    }
    case "binary": {
      if (node.op === "&&") return truthy(evalNode(node.left, ctx)) && truthy(evalNode(node.right, ctx));
      if (node.op === "||") return truthy(evalNode(node.left, ctx)) || truthy(evalNode(node.right, ctx));
      const l = evalNode(node.left, ctx);
      const r = evalNode(node.right, ctx);
      if (node.op === "==") return l == null && r == null ? true : l === r;
      if (node.op === "!=") return l == null && r == null ? false : l !== r;
      if (typeof l === "number" && typeof r === "number") return compare(node.op, l, r);
      if (typeof l === "string" && typeof r === "string") return compare(node.op, l, r);
      throw new ConditionError(`cannot compare ${typeof l} with ${typeof r} using "${node.op}"`);
    }
  }
}
function compare(op, l, r) {
  switch (op) {
    case ">":
      return l > r;
    case ">=":
      return l >= r;
    case "<":
      return l < r;
    default:
      return l <= r;
  }
}
function evaluateCondition(expr, ctx) {
  const ast = typeof expr === "string" ? parseCondition(expr) : expr;
  return truthy(evalNode(ast, ctx));
}

// src/workflows/types.ts
var nodeId = external_exports.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits and dashes");
var edgeSchema = external_exports.object({
  /** Condition expression; an edge without one is the fallback. */
  when: external_exports.string().min(1).max(500).optional(),
  to: nodeId,
  label: external_exports.string().max(64).optional()
}).strict();
var baseNode = {
  id: nodeId,
  label: external_exports.string().max(80).optional(),
  edges: external_exports.array(edgeSchema).max(20).optional(),
  /** Sugar for a single unconditional edge. */
  next: nodeId.optional()
};
var workflowNodeSchema = external_exports.discriminatedUnion("type", [
  external_exports.object({
    ...baseNode,
    type: external_exports.literal("agent"),
    agent: external_exports.string().min(1).max(64),
    /** Dotted paths this node may read. Defaults to the agent's own declaration. */
    inputs: external_exports.array(external_exports.string().min(1).max(200)).max(50).optional()
  }).strict(),
  external_exports.object({
    ...baseNode,
    type: external_exports.literal("command"),
    /** argv, never a shell string: the runtime spawns it without a shell. */
    command: external_exports.array(external_exports.string().min(1)).min(1).max(50),
    cwd: external_exports.string().max(500).optional(),
    /** Unset = one hour, the same default an agent node gets; 0 = no timeout. */
    timeoutMs: external_exports.number().int().min(0).optional()
  }).strict(),
  external_exports.object({ ...baseNode, type: external_exports.literal("condition") }).strict(),
  external_exports.object({
    id: nodeId,
    label: external_exports.string().max(80).optional(),
    type: external_exports.literal("parallel"),
    /** Branch entry nodes, started together. Each branch must reach `join`. */
    branches: external_exports.array(nodeId).min(2).max(10),
    /** Where the branches meet; the run continues here once all have finished. */
    join: nodeId
  }).strict(),
  external_exports.object({
    id: nodeId,
    label: external_exports.string().max(80).optional(),
    type: external_exports.literal("terminal"),
    status: external_exports.enum(["completed", "failed"]).default("completed")
  }).strict()
]);
var workspaceSchema = external_exports.object({
  /** Pins the pipeline to one repository; omitted, it is a per-run input. */
  repo: external_exports.string().min(1).max(500).optional(),
  /** What the run branches from (default HEAD). */
  baseRef: external_exports.string().min(1).max(200).optional(),
  branchPrefix: external_exports.string().min(1).max(60).regex(/^[A-Za-z0-9._/-]+$/, "use letters, digits, dots, slashes and dashes").optional()
}).strict();
var workflowDefinitionSchema = external_exports.object({
  name: external_exports.string().min(1).max(80),
  description: external_exports.string().max(500).optional(),
  entry: nodeId,
  /** Declared to give agents file/command tools and to run commands in a worktree. */
  workspace: workspaceSchema.optional(),
  /** Stop for the whole run. 0 — the default — means the run is not capped. */
  maxWorkflowSteps: external_exports.number().int().min(0).default(0),
  /** Stop for revisits of any single node (loop protection). 0 = uncapped. */
  maxVisits: external_exports.number().int().min(0).default(0),
  /**
   * Spend ceiling for the whole run, in USD of API-list-equivalent cost.
   * 0 — the default — means none. This is the ceiling worth setting: how many
   * tool rounds or node visits a task needs cannot be known in advance, but
   * what you are willing to spend on it can.
   */
  maxCostUsd: external_exports.number().min(0).default(0),
  nodes: external_exports.array(workflowNodeSchema).min(1).max(100)
}).strict();
function findNode(wf, id) {
  return wf.nodes.find((n) => n.id === id);
}
function successorsOf(node) {
  if (node.type === "parallel") return [...node.branches, node.join];
  return node.edges.map((e) => e.to);
}

// src/workflows/loader.ts
function invalid(id, message) {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message, { workflowId: id });
}
function parseWorkflow(id, raw, opts) {
  let doc;
  try {
    doc = load(raw) ?? {};
  } catch (e) {
    throw invalid(id, `invalid YAML: ${e.message}`);
  }
  const parsed = workflowDefinitionSchema.safeParse(doc);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw invalid(id, detail);
  }
  const nodes = parsed.data.nodes.map((n) => normalizeEdges(id, n));
  const wf = {
    ...parsed.data,
    id,
    nodes,
    sourcePath: opts.sourcePath,
    updatedAt: opts.updatedAt
  };
  validateStructure(wf, opts);
  return wf;
}
function normalizeEdges(workflowId, node) {
  if (node.type === "terminal" || node.type === "parallel") return { ...node, edges: [] };
  if (node.next && node.edges?.length) {
    throw invalid(workflowId, `node "${node.id}": use either "next" or "edges", not both`);
  }
  const raw = node.next ? [{ to: node.next }] : node.edges ?? [];
  const edges = raw.map((e) => {
    if (!e.when) return { ...e, condition: null };
    try {
      return { ...e, condition: parseCondition(e.when) };
    } catch (err) {
      const message = err instanceof ConditionError ? err.message : String(err);
      throw invalid(workflowId, `node "${node.id}": ${message}`);
    }
  });
  return { ...node, edges };
}
function validateStructure(wf, opts) {
  const ids = /* @__PURE__ */ new Set();
  for (const n of wf.nodes) {
    if (ids.has(n.id)) throw invalid(wf.id, `duplicate node id "${n.id}"`);
    ids.add(n.id);
  }
  if (!ids.has(wf.entry)) throw invalid(wf.id, `entry node "${wf.entry}" does not exist`);
  if (!wf.nodes.some((n) => n.type === "terminal")) throw invalid(wf.id, "workflow has no terminal node");
  for (const n of wf.nodes) {
    if (n.type === "terminal") continue;
    if (n.type === "parallel") {
      validateParallel(wf, n, ids);
      continue;
    }
    if (!n.edges.length) throw invalid(wf.id, `node "${n.id}" has no outgoing edge`);
    for (const e of n.edges) {
      if (!ids.has(e.to)) throw invalid(wf.id, `node "${n.id}" points at unknown node "${e.to}"`);
      for (const path of e.condition ? conditionPaths(e.condition) : []) {
        if (path[0] === "outputs" && path[1] && !ids.has(path[1])) {
          throw invalid(wf.id, `node "${n.id}" condition reads unknown node output "${path[1]}"`);
        }
        if (path[0] === "visits" && path[1] && !ids.has(path[1])) {
          throw invalid(wf.id, `node "${n.id}" condition counts visits to unknown node "${path[1]}"`);
        }
        if (path[0] !== "outputs" && path[0] !== "input" && path[0] !== "visits") {
          throw invalid(
            wf.id,
            `node "${n.id}" condition reads "${path[0]}"; only "outputs", "input" and "visits" are available`
          );
        }
      }
    }
    if (n.type === "condition" && !n.edges.some((e) => e.condition)) {
      throw invalid(wf.id, `condition node "${n.id}" has no conditional edge`);
    }
    if (n.edges.filter((e) => !e.condition).length > 1) {
      throw invalid(wf.id, `node "${n.id}" has more than one fallback edge`);
    }
    if (n.type === "agent" && opts.agentExists && !opts.agentExists(n.agent)) {
      throw invalid(wf.id, `node "${n.id}" references unknown agent "${n.agent}"`);
    }
  }
  const reachable = /* @__PURE__ */ new Set([wf.entry]);
  const queue = [wf.entry];
  while (queue.length) {
    const id = queue.shift();
    const cur = wf.nodes.find((n) => n.id === id);
    for (const to of cur ? successorsOf(cur) : []) {
      if (!reachable.has(to)) {
        reachable.add(to);
        queue.push(to);
      }
    }
  }
  const orphans = wf.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
  if (orphans.length) throw invalid(wf.id, `unreachable node${orphans.length > 1 ? "s" : ""}: ${orphans.join(", ")}`);
}
function validateParallel(wf, node, ids) {
  const at = `parallel node "${node.id}"`;
  if (!ids.has(node.join)) throw invalid(wf.id, `${at} joins at unknown node "${node.join}"`);
  if (node.join === node.id) throw invalid(wf.id, `${at} cannot join at itself`);
  if (new Set(node.branches).size !== node.branches.length) throw invalid(wf.id, `${at} lists the same branch twice`);
  const regions = /* @__PURE__ */ new Map();
  for (const branch of node.branches) {
    if (!ids.has(branch)) throw invalid(wf.id, `${at} starts unknown branch "${branch}"`);
    if (branch === node.join) throw invalid(wf.id, `${at} uses its join node "${branch}" as a branch`);
    if (branch === node.id) throw invalid(wf.id, `${at} lists itself as a branch`);
    regions.set(branch, regionOf(wf, branch, node.join));
  }
  const owned = /* @__PURE__ */ new Map();
  for (const [branch, region] of regions) {
    for (const id of region) {
      const other = owned.get(id);
      if (other) throw invalid(wf.id, `${at}: branches "${other}" and "${branch}" both contain node "${id}"`);
      owned.set(id, branch);
    }
  }
  if (owned.has(node.id)) throw invalid(wf.id, `${at} is reachable from inside its own branches`);
  for (const [branch, region] of regions) {
    let reachesJoin = false;
    for (const id of region) {
      const cur = wf.nodes.find((n) => n.id === id);
      if (cur.type === "terminal") {
        throw invalid(wf.id, `${at}: branch "${branch}" ends the workflow at "${id}"; a branch must reach the join node "${node.join}"`);
      }
      if (successorsOf(cur).includes(node.join)) reachesJoin = true;
    }
    if (!reachesJoin) throw invalid(wf.id, `${at}: branch "${branch}" never reaches the join node "${node.join}"`);
  }
  for (const other of wf.nodes) {
    if (other.id === node.id || owned.has(other.id)) continue;
    for (const to of successorsOf(other)) {
      const branch = owned.get(to);
      if (branch) {
        throw invalid(wf.id, `node "${other.id}" points into branch "${branch}" of ${at}; a branch is entered only through "${node.id}"`);
      }
    }
  }
}
function regionOf(wf, start, stop) {
  const seen = /* @__PURE__ */ new Set([start]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    const cur = wf.nodes.find((n) => n.id === id);
    for (const to of cur ? successorsOf(cur) : []) {
      if (to === stop || seen.has(to)) continue;
      seen.add(to);
      queue.push(to);
    }
  }
  return seen;
}

// src/workflows/registry.ts
var ID_RE2 = /^[a-z0-9][a-z0-9-]{0,63}$/;
function workflowsDir(scope = teamScope()) {
  return join5(scope.root, "workflows");
}
function invalid2(id, message) {
  return new WorkflowError("WORKFLOW_DEFINITION_INVALID", message, { workflowId: id });
}
function pathFor2(id, scope) {
  if (!ID_RE2.test(id)) throw invalid2(id, "invalid workflow id (use lowercase letters, digits and dashes)");
  const yaml = join5(workflowsDir(scope), `${id}.yaml`);
  if (existsSync4(yaml)) return yaml;
  const yml = join5(workflowsDir(scope), `${id}.yml`);
  return existsSync4(yml) ? yml : yaml;
}
var cache2 = /* @__PURE__ */ new Map();
function loadFile2(id, file, scope) {
  const stat = statSync3(file);
  const key = `${scope.teamId ?? scope.root}\0${file}`;
  const hit = cache2.get(key);
  if (hit && hit.mtimeMs === stat.mtimeMs) return hit.def;
  const def = parseWorkflow(id, readFileSync3(file, "utf8"), {
    sourcePath: file,
    updatedAt: stat.mtimeMs,
    agentExists: (agentId) => agentExists(agentId, scope)
  });
  cache2.set(key, { mtimeMs: stat.mtimeMs, def });
  return def;
}
function resolveFile2(id, scope) {
  const own = pathFor2(id, scope);
  if (existsSync4(own)) return own;
  if (scope.fallback) return resolveFile2(id, scope.fallback);
  return null;
}
function getWorkflow(id, scope = teamScope()) {
  const file = resolveFile2(id, scope);
  if (!file) throw invalid2(id, "workflow not found");
  return loadFile2(id, file, scope);
}
function readWorkflowSource(id, scope = teamScope()) {
  const file = resolveFile2(id, scope);
  if (!file) throw invalid2(id, "workflow not found");
  return readFileSync3(file, "utf8");
}

// src/lib/connect-token.ts
var CONNECT_TOKEN_PREFIX = "gatec_";
function fromBase64Url(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}
function looksLikeConnectionToken(value) {
  return value.trim().startsWith(CONNECT_TOKEN_PREFIX);
}
function decodeConnectionToken(value) {
  const token = value.trim();
  if (!looksLikeConnectionToken(token)) {
    throw new Error(`that does not look like a gate token (they start with ${CONNECT_TOKEN_PREFIX})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(new TextDecoder().decode(fromBase64Url(token.slice(CONNECT_TOKEN_PREFIX.length))));
  } catch {
    throw new Error("this token is damaged \u2014 copy it again from your gate dashboard, all of it");
  }
  const { u, k } = parsed ?? {};
  if (typeof u !== "string" || typeof k !== "string" || !u || !k) {
    throw new Error("this token is missing the gate address or the key");
  }
  if (!/^https?:\/\//.test(u)) {
    throw new Error(`this token points at "${u}", which is not an http(s) address`);
  }
  return { url: u.replace(/\/+$/, ""), key: k };
}

// src/client/api.ts
import { hostname } from "node:os";

// src/lib/protocol.ts
var GATE_VERSION = "0.14.0";
var VERSION_HEADERS = {
  /** Client → server: the CLI's own version. */
  client: "x-gate-cli",
  /** Server → client: what is running there. */
  server: "x-gate-server",
  /** Server → client: the oldest client it will serve. */
  minClient: "x-gate-min-cli"
};
function compareVersions(a, b) {
  const parts = (v) => v.trim().split(".").map((n) => Number.parseInt(n, 10)).map((n) => Number.isFinite(n) ? n : 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}
function isOlderThan(version, than) {
  return compareVersions(version, than) < 0;
}

// src/client/api.ts
var CLI_VERSION = GATE_VERSION;
var GateApiError = class extends Error {
  constructor(message, status, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = "GateApiError";
  }
  status;
  code;
};
var GateClient = class {
  constructor(config) {
    this.config = config;
  }
  config;
  warnedAboutVersion = false;
  get url() {
    return this.config.url;
  }
  get gatewayUrl() {
    return `${this.config.url}/api/gateway`;
  }
  get key() {
    return this.config.key;
  }
  headers(extra = {}) {
    return {
      authorization: `Bearer ${this.config.key}`,
      "x-gate-host": hostname(),
      [VERSION_HEADERS.client]: CLI_VERSION,
      ...extra
    };
  }
  async request(path, init = {}) {
    let res;
    try {
      res = await fetch(`${this.config.url}${path}`, {
        ...init,
        headers: this.headers(init.body ? { "content-type": "application/json" } : {})
      });
    } catch (e) {
      const cause = e.cause?.message;
      throw new GateApiError(
        `cannot reach gate at ${this.config.url} (${e.message}${cause ? `: ${cause}` : ""})`,
        0,
        "UNREACHABLE"
      );
    }
    this.noteVersions(res);
    if (res.status === 304) return { status: 304, body: null };
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
    }
    if (!res.ok) {
      const detail = json?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
      throw new GateApiError(detail, res.status, json?.code);
    }
    return { status: res.status, body: json };
  }
  /**
   * Notices, once, that this CLI is behind the gate it is talking to.
   *
   * Only a warning: being a version behind is the normal state of a tool
   * installed on a dozen machines, and refusing on that alone would stop work
   * for nothing. The server refuses the versions it genuinely cannot serve.
   */
  noteVersions(res) {
    if (this.warnedAboutVersion) return;
    const server = res.headers.get(VERSION_HEADERS.server);
    if (!server || !isOlderThan(CLI_VERSION, server)) return;
    this.warnedAboutVersion = true;
    console.error(
      `# gate ${CLI_VERSION} here, ${server} on ${this.config.url} \u2014 run \`/plugin update gate@gateway\` in Claude Code when convenient`
    );
  }
  async me() {
    return (await this.request("/api/v1/me")).body;
  }
  /** null when the bundle has not changed since `etag`. */
  async bundle(etag) {
    const res = await this.request("/api/v1/bundle", {
      headers: etag ? { "if-none-match": `"${etag}"` } : void 0
    });
    return res.status === 304 ? null : res.body;
  }
  async startRun(input) {
    const res = await this.request("/api/v1/executions", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return res.body.executionId;
  }
  /** Reports progress; the reply says whether someone asked the run to stop. */
  async report(executionId, payload) {
    const res = await this.request(`/api/v1/executions/${executionId}/events`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
    return res.body;
  }
  async finish(executionId, payload) {
    await this.request(`/api/v1/executions/${executionId}/finish`, {
      method: "POST",
      body: JSON.stringify(payload)
    });
  }
  /** Asks a run to stop; it settles on its own next report. */
  async cancel(executionId) {
    const res = await this.request(
      `/api/v1/executions/${executionId}/cancel`,
      { method: "POST", body: "{}" }
    );
    return res.body;
  }
  /** Writes one definition into the caller's team. Needs a key with `author`. */
  async saveDefinition(input) {
    const res = await this.request("/api/v1/definitions", {
      method: "POST",
      body: JSON.stringify(input)
    });
    return res.body;
  }
  /**
   * Deletes every definition the caller's team owns. The team's own id is sent
   * back as the confirmation, so this cannot be reached by a stray request.
   */
  async wipeTeamDefinitions() {
    const me = await this.me();
    const res = await this.request(
      `/api/v1/definitions?confirm=${encodeURIComponent(me.team.id)}`,
      { method: "DELETE" }
    );
    return res.body;
  }
  async listRuns(limit = 20) {
    const res = await this.request(`/api/v1/executions?limit=${limit}`);
    return res.body.executions;
  }
};

// src/client/cache.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync6, readFileSync as readFileSync5, readdirSync as readdirSync4, rmSync as rmSync3, writeFileSync as writeFileSync5 } from "node:fs";
import { join as join7 } from "node:path";

// src/client/config.ts
import { mkdirSync as mkdirSync5, readFileSync as readFileSync4, writeFileSync as writeFileSync4 } from "node:fs";
import { homedir as homedir3 } from "node:os";
import { dirname, join as join6 } from "node:path";
function gateHome2() {
  return process.env.GATE_HOME || join6(homedir3(), ".gate");
}
function configPath() {
  return join6(gateHome2(), "client.json");
}
function readConfig() {
  const url = process.env.GATE_URL;
  const key = process.env.GATE_KEY;
  if (url && key) return { url: url.replace(/\/+$/, ""), key };
  try {
    const raw = JSON.parse(readFileSync4(configPath(), "utf8"));
    if (!raw?.url || !raw?.key) return null;
    return { ...raw, url: raw.url.replace(/\/+$/, "") };
  } catch {
    return null;
  }
}
function writeConfig(config) {
  const file = configPath();
  mkdirSync5(dirname(file), { recursive: true, mode: 448 });
  writeFileSync4(file, `${JSON.stringify(config, null, 2)}
`, { mode: 384 });
}
function readConfigFile() {
  try {
    return JSON.parse(readFileSync4(configPath(), "utf8"));
  } catch {
    return null;
  }
}
function trustWorkflow(id, sha) {
  const onDisk = readConfigFile();
  const trusted = { ...onDisk?.trusted ?? {}, [id]: sha };
  if (onDisk) {
    writeConfig({ ...onDisk, trusted });
    return;
  }
  writeConfig({ url: "", key: "", trusted });
}
function isTrusted(id, sha) {
  return readConfigFile()?.trusted?.[id] === sha;
}
function setRepoPath(id, path) {
  const onDisk = readConfigFile();
  const repos = { ...onDisk?.repos ?? {}, [id]: path };
  writeConfig(onDisk ? { ...onDisk, repos } : { url: "", key: "", repos });
}
function repoPaths() {
  return readConfigFile()?.repos ?? {};
}

// src/client/cache.ts
function cacheDir(team) {
  return join7(gateHome2(), "cache", team);
}
function cacheScope(team) {
  return scopeAt(cacheDir(team), team);
}
function manifestPath(team) {
  return join7(cacheDir(team), "manifest.json");
}
function readManifest(team) {
  try {
    return JSON.parse(readFileSync5(manifestPath(team), "utf8"));
  } catch {
    return null;
  }
}
function writeBundle(bundle, from) {
  const root = cacheDir(bundle.team);
  const agents = join7(root, "agents");
  const workflows = join7(root, "workflows");
  mkdirSync6(agents, { recursive: true, mode: 448 });
  mkdirSync6(workflows, { recursive: true, mode: 448 });
  for (const agent of bundle.agents) {
    writeFileSync5(join7(agents, `${agent.id}.md`), agent.source, { mode: 384 });
  }
  for (const workflow of bundle.workflows) {
    writeFileSync5(join7(workflows, `${workflow.id}.yaml`), workflow.source, { mode: 384 });
  }
  prune(agents, new Set(bundle.agents.map((a) => `${a.id}.md`)));
  prune(workflows, new Set(bundle.workflows.map((w) => `${w.id}.yaml`)));
  const manifest = {
    team: bundle.team,
    hash: bundle.hash,
    pulledAt: Date.now(),
    from,
    workflows: bundle.workflows.map(({ source: _source, ...rest }) => rest)
  };
  writeFileSync5(manifestPath(bundle.team), `${JSON.stringify(manifest, null, 2)}
`, { mode: 384 });
  return manifest;
}
function prune(dir, keep) {
  if (!existsSync5(dir)) return;
  for (const entry of readdirSync4(dir)) {
    if (!keep.has(entry)) rmSync3(join7(dir, entry), { force: true });
  }
}
function clearLocalState() {
  const removed = [];
  const cache3 = join7(gateHome2(), "cache");
  if (existsSync5(cache3)) {
    rmSync3(cache3, { recursive: true, force: true });
    removed.push(`removed the mirrored definitions (${cache3})`);
  }
  const config = join7(gateHome2(), "client.json");
  if (existsSync5(config)) {
    rmSync3(config, { force: true });
    removed.push(`removed the login and its approvals (${config})`);
  }
  const workspaces = join7(gateHome2(), "workspaces");
  if (existsSync5(workspaces)) {
    const kept = readdirSync4(workspaces).length;
    if (kept) removed.push(`kept ${kept} run worktree(s) in ${workspaces} \u2014 they are branches, not cache`);
  }
  return removed.length ? removed : ["nothing to remove \u2014 this machine was not connected"];
}

// src/client/run.ts
import { execFileSync as execFileSync2 } from "node:child_process";
import { homedir as homedir5, hostname as hostname2 } from "node:os";
import { resolve as resolve5 } from "node:path";

// src/runtime/engine.ts
import { randomUUID } from "node:crypto";
import { existsSync as existsSync7 } from "node:fs";

// src/lib/pricing.ts
var PRICE_PER_MTOK = {
  haiku: { input: 1, output: 5 },
  sonnet: { input: 2, output: 10 },
  opus: { input: 5, output: 25 },
  fable: { input: 10, output: 50 }
};
function tierOf(model) {
  const m = model.toLowerCase();
  if (m.includes("haiku")) return "haiku";
  if (m.includes("fable") || m.includes("mythos")) return "fable";
  if (m.includes("opus")) return "opus";
  return "sonnet";
}
function cacheReadMultiplier(model) {
  const m = (model ?? "").toLowerCase();
  return /fable-5-1|mythos-5-1/.test(m) ? 0.025 : 0.1;
}
function costForUsage(tier, u, opts = {}) {
  const p = PRICE_PER_MTOK[tier];
  const writeMult = opts.cacheTtl === "1h" ? 2 : 1.25;
  return (u.input * p.input + (u.cacheRead ?? 0) * p.input * cacheReadMultiplier(opts.model) + (u.cacheCreation ?? 0) * p.input * writeMult + u.output * p.output) / 1e6;
}

// src/runtime/state.ts
function createState(executionId, workflowId, input = {}, seed) {
  return {
    executionId,
    workflowId,
    status: "running",
    input,
    outputs: seed?.outputs ?? {},
    visitCounts: seed?.visitCounts ?? {},
    stepCount: seed?.stepCount ?? 0,
    history: seed?.history ?? [],
    error: null
  };
}
function conditionContext(state) {
  return { outputs: state.outputs, input: state.input, visits: state.visitCounts };
}
function readPath(root, segments) {
  let cur = root;
  for (const seg of segments) {
    if (cur == null || typeof cur !== "object") return void 0;
    cur = cur[seg];
  }
  return cur;
}
function resolveInputs(paths, state, nodeId2) {
  const out = {};
  for (const raw of paths) {
    const optional = raw.endsWith("?");
    const path = optional ? raw.slice(0, -1) : raw;
    const segments = path.split(".").filter(Boolean);
    if (!segments.length) continue;
    const root = segments[0];
    const found = root === "input" ? readPath(state.input, segments.slice(1)) : root === "visits" ? (
      // A node that has not run yet has been visited zero times, not
      // "absent" — an agent told which attempt this is reads 1 on the
      // first pass rather than failing on an input nobody produced.
      readPath(state.visitCounts, segments.slice(1)) ?? 0
    ) : readPath(state.outputs, segments);
    if (found === void 0 && !optional) {
      throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${nodeId2}" requires input "${path}", which has not been produced yet`, {
        nodeId: nodeId2,
        path
      });
    }
    const value = found === void 0 ? "" : found;
    let cursor = out;
    for (let i = 0; i < segments.length - 1; i++) {
      const key = segments[i];
      if (typeof cursor[key] !== "object" || cursor[key] === null) cursor[key] = {};
      cursor = cursor[key];
    }
    cursor[segments[segments.length - 1]] = value;
  }
  return out;
}

// src/runtime/executors/claude-code.ts
import { spawn } from "node:child_process";
import { existsSync as existsSync6 } from "node:fs";
function gatewayUrl(override) {
  if (override) return `${override.replace(/\/$/, "")}`;
  if (process.env.GATE_SELF_URL)
    return `${process.env.GATE_SELF_URL.replace(/\/$/, "")}/api/gateway`;
  return `http://127.0.0.1:${process.env.PORT ?? 4141}/api/gateway`;
}
function renderResult(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map(
      (b) => b && typeof b === "object" && "text" in b ? String(b.text) : JSON.stringify(b)
    ).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}
var MAX_OUTPUT_RETRIES = 2;
async function runClaudeCodeNode(agent, prompt, nodeId2, deps, deadline) {
  if (!deps.workspace) {
    throw new WorkflowError(
      "AGENT_DEFINITION_INVALID",
      `node "${nodeId2}": agent "${agent.id}" uses the claude-code executor, which needs a workspace; declare one on the workflow`,
      { nodeId: nodeId2, agentId: agent.id }
    );
  }
  const workspace = deps.workspace;
  if (!existsSync6(workspace.root)) {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `node "${nodeId2}": this run's worktree is gone (${workspace.root}); it was removed while the run was going`,
      { nodeId: nodeId2, agentId: agent.id }
    );
  }
  const toolCalls = [];
  const usage = {
    model: agent.model,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0
  };
  const runTurn = async (userPrompt, resume) => {
    const args = [
      "-p",
      userPrompt,
      // Not `json`: that returns one blob when the node is already over, and the
      // dashboard has nothing to show for the half hour before it. `stream-json`
      // emits every tool call as it happens, which is what feeds tool.called.
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      agent.model,
      "--add-dir",
      workspace.root,
      // A run is unattended, so nothing may wait for an answer.
      //
      // Not `bypassPermissions`: Claude Code refuses that outright when the
      // process is root, which is how gate runs as a service — and it refuses
      // for a good reason, because that mode as root is unrestricted execution
      // on the host. `auto` decides without asking, and `--permission-prompts
      // none` denies whatever would still have prompted rather than hanging on
      // a question nobody is there to answer.
      "--permission-mode",
      "auto",
      "--permission-prompts",
      "none"
    ];
    if (agent.effort) args.push("--effort", agent.effort);
    if (resume) args.push("--resume", resume);
    if (agent.output.type === "json") {
      const fields = Object.entries(agent.output.schema).map(([field, type]) => `  "${field}": ${type}`).join("\n");
      args.push(
        "--append-system-prompt",
        `When you have finished the work, your final message must be a single JSON object and nothing else \u2014 no prose, no code fence. Fields:
{
${fields}
}
A type ending in "?" is optional.`
      );
    }
    const spawnCli = deps.spawnCli ?? spawn;
    const child = spawnCli("claude", args, {
      cwd: workspace.root,
      env: {
        ...process.env,
        ANTHROPIC_BASE_URL: gatewayUrl(deps.gatewayUrl),
        // Only set when the caller has one: on the server the gateway is
        // loopback and needs no key, and an empty value would be sent as one.
        ...deps.authToken ? { ANTHROPIC_AUTH_TOKEN: deps.authToken, ANTHROPIC_API_KEY: deps.authToken } : {},
        // Claude Code would otherwise send only its own session id, and the
        // gateway would file a node's calls as unrelated traffic. This is the
        // same header gate's own provider sets (`sessionFromRequest` prefers
        // it), so a node run by the child groups, sticks to its tier and reuses
        // its prompt cache exactly like one gate held itself.
        ...deps.sessionId ? { ANTHROPIC_CUSTOM_HEADERS: `x-gate-session: ${deps.sessionId}` } : {}
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    let final = null;
    const pending = /* @__PURE__ */ new Map();
    let buffered = "";
    const onEvent = (e) => {
      if (e.type === "result") {
        final = e;
        return;
      }
      const blocks = e.message?.content;
      if (!Array.isArray(blocks)) return;
      for (const b of blocks) {
        if (b.type === "tool_use" && typeof b.id === "string") {
          pending.set(b.id, {
            tool: b.name ?? "tool",
            input: b.input,
            startedAt: Date.now()
          });
        }
        if (b.type === "tool_result" && typeof b.tool_use_id === "string") {
          const started = pending.get(b.tool_use_id);
          pending.delete(b.tool_use_id);
          const record = {
            tool: started?.tool ?? "tool",
            input: started?.input ?? null,
            ok: b.is_error !== true,
            result: renderResult(b.content),
            startedAt: started?.startedAt ?? Date.now(),
            durationMs: started ? Date.now() - started.startedAt : 0
          };
          toolCalls.push(record);
          deps.onToolCall?.(record);
        }
      }
    };
    child.stdout?.on("data", (c) => {
      buffered += c.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          onEvent(JSON.parse(line));
        } catch {
        }
      }
    });
    child.stderr?.on("data", (c) => stderr += c.toString());
    const settled = await new Promise((resolve7) => {
      let done = false;
      const finish = (r) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", onAbort);
        resolve7(r);
      };
      const timer = deadline === null ? void 0 : setTimeout(
        () => {
          child.kill("SIGKILL");
          finish({ code: null, timedOut: true, cancelled: false });
        },
        Math.max(0, deadline - Date.now())
      );
      const onAbort = () => {
        child.kill("SIGKILL");
        finish({ code: null, timedOut: false, cancelled: true });
      };
      deps.signal?.addEventListener("abort", onAbort, { once: true });
      child.on(
        "error",
        () => finish({ code: null, timedOut: false, cancelled: false })
      );
      child.on(
        "close",
        (code) => finish({ code, timedOut: false, cancelled: false })
      );
    });
    if (buffered.trim()) {
      try {
        onEvent(JSON.parse(buffered));
      } catch {
      }
    }
    if (settled.cancelled) {
      throw new WorkflowError(
        "RUN_CANCELLED",
        `node "${nodeId2}" was cancelled`,
        { nodeId: nodeId2 }
      );
    }
    if (settled.timedOut) {
      throw new WorkflowError(
        "NODE_TIMEOUT",
        `node "${nodeId2}" exceeded its timeout`,
        { nodeId: nodeId2 }
      );
    }
    const parsed = final;
    if (!parsed) {
      const detail = (stderr.trim() || "no output").slice(0, 500);
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `node "${nodeId2}": claude-code exited ${settled.code ?? "without a code"} before reporting a result \u2014 ${detail}`,
        { nodeId: nodeId2, agentId: agent.id, toolCalls }
      );
    }
    usage.model = modelOf(parsed) ?? usage.model;
    usage.inputTokens += parsed.usage?.input_tokens ?? 0;
    usage.outputTokens += parsed.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += parsed.usage?.cache_read_input_tokens ?? 0;
    if (parsed.is_error || typeof parsed.result !== "string") {
      throw new WorkflowError(
        "MODEL_EXECUTION_ERROR",
        `node "${nodeId2}": claude-code did not finish (${parsed.subtype ?? "unknown"})` + // Denials are silent otherwise, and a node that lost the tool it
        // needed reads exactly like one that simply answered badly.
        (parsed.permission_denials?.length ? `; ${parsed.permission_denials.length} tool call(s) denied by the permission mode` : ""),
        // The tool calls it did make and the tokens it did spend are attached, so
        // a failure is recorded with its evidence instead of looking like nothing.
        { nodeId: nodeId2, agentId: agent.id, usage, toolCalls }
      );
    }
    return parsed;
  };
  let turn = await runTurn(prompt);
  for (let attempt = 0; ; attempt++) {
    try {
      return {
        output: parseOutput(agent, turn.result, nodeId2),
        usage,
        toolCalls
      };
    } catch (e) {
      const validation = e instanceof WorkflowError && e.code === "AGENT_OUTPUT_VALIDATION_ERROR";
      if (!validation || attempt >= MAX_OUTPUT_RETRIES || !turn.session_id)
        throw e;
      turn = await runTurn(
        outputCorrection(e.message),
        turn.session_id
      );
    }
  }
}
function modelOf(r) {
  const keys = r.modelUsage ? Object.keys(r.modelUsage) : [];
  return keys.length ? keys[0] : null;
}

// src/runtime/executors/agent.ts
var MAX_TOOL_ITERATIONS = 0;
var DEFAULT_AGENT_TIMEOUT_MS = 60 * 6e4;
var WRITE_TOOLS = /* @__PURE__ */ new Set(["write_file", "edit_file"]);
var RECON_ROUNDS_BEFORE_NUDGE = 12;
var NUDGE_EVERY_ROUNDS = 10;
var MAX_OUTPUT_RETRIES2 = 2;
function outputCorrection(message) {
  return `Your last message did not match the output shape this node declared: ${message}

Send the same answer again, corrected, as a single JSON object and nothing else \u2014 no prose, no code fence. Do not redo any work; only the shape of the final message was wrong.`;
}
async function executeAgentNode(node, state, deps) {
  const agent = deps.loadAgent(node.agent);
  const paths = node.inputs ?? agent.inputs;
  const inputs = resolveInputs(paths, state, node.id);
  let prompt;
  try {
    prompt = renderTemplate(agent.prompt, { inputs, input: state.input });
  } catch (e) {
    const message = e instanceof TemplateError ? e.message : String(e);
    throw new WorkflowError("AGENT_DEFINITION_INVALID", `node "${node.id}": ${message}`, { nodeId: node.id, agentId: agent.id });
  }
  const workspace = deps.workspace ?? null;
  const nodeTimeoutMs = agent.timeoutMs ?? DEFAULT_AGENT_TIMEOUT_MS;
  const nodeDeadline = nodeTimeoutMs > 0 ? Date.now() + nodeTimeoutMs : null;
  if (agent.executor === "claude-code") {
    const res = await runClaudeCodeNode(
      agent,
      prompt,
      node.id,
      {
        workspace,
        onToolCall: deps.onToolCall,
        signal: deps.signal,
        gatewayUrl: deps.claudeCode?.gatewayUrl,
        authToken: deps.claudeCode?.authToken,
        sessionId: `workflow:${state.executionId}`
      },
      nodeDeadline
    );
    return { input: inputs, output: res.output, usage: res.usage, toolCalls: res.toolCalls };
  }
  const tools = toolsFor(agent.tools, Boolean(workspace));
  const canWrite = tools.some((t) => WRITE_TOOLS.has(t.name));
  const toolDefs = tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema }));
  const toolCtx = workspace ? { root: workspace.root, nodeId: node.id, executionId: state.executionId } : null;
  const messages = [{ role: "user", content: prompt }];
  const toolCalls = [];
  let writes = 0;
  const usage = { model: agent.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const deadline = nodeDeadline;
  const maxIterations = agent.maxToolIterations ?? deps.maxToolIterations ?? MAX_TOOL_ITERATIONS;
  let outputRetries = 0;
  try {
    for (let iteration = 0; ; iteration++) {
      if (deps.signal?.aborted) {
        throw new WorkflowError("RUN_CANCELLED", `node "${node.id}" was cancelled`, { nodeId: node.id });
      }
      const call = deps.provider.execute({
        model: agent.model,
        system: systemPrompt(agent, tools.length > 0, canWrite),
        messages,
        effort: agent.effort,
        maxTokens: agent.maxTokens,
        tools: toolDefs.length ? toolDefs : void 0,
        context: { executionId: state.executionId, workflowId: state.workflowId, nodeId: node.id },
        signal: deps.signal
      });
      const result = await withDeadline(call, deadline, node.id);
      usage.model = result.model;
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      usage.cacheReadTokens += result.usage.cacheReadTokens;
      if (result.stopReason === "max_tokens") {
        throw new WorkflowError(
          "AGENT_OUTPUT_TRUNCATED",
          `node "${node.id}": agent "${agent.id}" hit its output limit (${agent.maxTokens ?? 8192} max tokens); raise maxTokens in the agent file`,
          { nodeId: node.id, agentId: agent.id }
        );
      }
      if (!result.toolUses.length) {
        try {
          return { input: inputs, output: parseOutput(agent, result.text, node.id), usage, toolCalls };
        } catch (e) {
          const validation = e instanceof WorkflowError && e.code === "AGENT_OUTPUT_VALIDATION_ERROR";
          if (!validation || outputRetries >= MAX_OUTPUT_RETRIES2) throw e;
          outputRetries++;
          messages.push({ role: "assistant", content: result.content });
          messages.push({ role: "user", content: [{ type: "text", text: outputCorrection(e.message) }] });
          continue;
        }
      }
      if (maxIterations > 0 && iteration >= maxIterations) {
        throw new WorkflowError(
          "TOOL_LIMIT_EXCEEDED",
          `node "${node.id}": agent "${agent.id}" made ${maxIterations} tool rounds without answering`,
          { nodeId: node.id, agentId: agent.id }
        );
      }
      messages.push({ role: "assistant", content: result.content });
      const results = [];
      for (const use of result.toolUses) {
        const record = await runTool(use, toolCtx, agent);
        toolCalls.push(record);
        deps.onToolCall?.(record);
        if (record.ok && WRITE_TOOLS.has(use.name)) writes++;
        results.push({ type: "tool_result", toolUseId: use.id, content: record.result, isError: !record.ok });
      }
      const nudge = canWrite && writes === 0 ? reconNudge(iteration + 1, toolCalls.length) : null;
      if (nudge) results.push({ type: "text", text: nudge });
      messages.push({ role: "user", content: results });
    }
  } catch (e) {
    if (e instanceof WorkflowError) throw new WorkflowError(e.code, e.message, { ...e.detail, toolCalls, usage });
    throw e;
  }
}
async function runTool(use, ctx, agent) {
  const startedAt = Date.now();
  const base = { tool: use.name, input: use.input, startedAt };
  const tool = getTool(use.name);
  if (!tool || !agent.tools.includes(use.name) || !ctx) {
    return { ...base, ok: false, durationMs: 0, result: `tool "${use.name}" is not available to this agent` };
  }
  try {
    const result = await tool.execute(use.input ?? {}, ctx);
    return { ...base, ok: true, durationMs: Date.now() - startedAt, result };
  } catch (e) {
    const message = e instanceof ToolError ? e.message : `${e.message}`;
    return { ...base, ok: false, durationMs: Date.now() - startedAt, result: `error: ${message}` };
  }
}
function reconNudge(rounds, toolCallCount) {
  if (rounds < RECON_ROUNDS_BEFORE_NUDGE) return null;
  if ((rounds - RECON_ROUNDS_BEFORE_NUDGE) % NUDGE_EVERY_ROUNDS !== 0) return null;
  return `You have made ${toolCallCount} tool calls in this node and have not written anything to the worktree yet. The worktree is the deliverable: nothing downstream reads this answer for the change itself, and a node that ends with an unchanged worktree fails. Apply the part of the change you already understand, now, with write_file or edit_file \u2014 then keep reading between edits instead of before them.`;
}
function systemPrompt(agent, hasTools, canWrite) {
  const parts = [`You are the "${agent.name}" agent in an automated workflow.`];
  if (agent.description) parts.push(agent.description);
  if (hasTools) {
    parts.push(
      canWrite ? "You are working in a git worktree of the target repository, and that worktree is your output: every change you decide on, you apply there yourself with the write and edit tools. Nothing reads your final answer for the change itself. Work change by change \u2014 read what the edit in front of you needs, make it, verify it, move on \u2014 rather than surveying the whole repository first and writing at the end. Tool paths are relative to the worktree root." : "You are working in a git worktree of the target repository. Tool paths are relative to its root. Read what you need, and base what you report on what you actually read rather than on what a name suggests."
    );
  }
  if (agent.output.type === "json") {
    const fields = Object.entries(agent.output.schema).map(([field, type]) => `  "${field}": ${type}`).join("\n");
    parts.push(
      `${hasTools ? "When you are done working, your final message must be a single JSON object" : "Respond with a single JSON object"} and nothing else \u2014 no prose, no code fence. Fields:
{
${fields}
}
A type ending in "?" is optional.`
    );
  }
  return parts.join("\n\n");
}
function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}
function parseOutput(agent, text, nodeId2) {
  if (agent.output.type === "text") return text.trim();
  let parsed;
  try {
    parsed = JSON.parse(extractJson(text));
  } catch {
    throw new WorkflowError("AGENT_OUTPUT_VALIDATION_ERROR", `node "${nodeId2}": agent "${agent.id}" did not return JSON`, {
      nodeId: nodeId2,
      agentId: agent.id,
      text: text.slice(0, 2e3)
    });
  }
  const validated = buildOutputSchema(agent.output).safeParse(parsed);
  if (!validated.success) {
    const detail = validated.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new WorkflowError("AGENT_OUTPUT_VALIDATION_ERROR", `node "${nodeId2}": agent "${agent.id}" output invalid \u2014 ${detail}`, {
      nodeId: nodeId2,
      agentId: agent.id
    });
  }
  return validated.data;
}
function withDeadline(p, deadline, nodeId2) {
  if (!deadline) return p;
  const remaining = deadline - Date.now();
  if (remaining <= 0) return Promise.reject(new WorkflowError("NODE_TIMEOUT", `node "${nodeId2}" ran out of time`, { nodeId: nodeId2 }));
  return new Promise((resolve7, reject) => {
    const timer = setTimeout(
      () => reject(new WorkflowError("NODE_TIMEOUT", `node "${nodeId2}" exceeded its timeout`, { nodeId: nodeId2 })),
      remaining
    );
    p.then(resolve7, reject).finally(() => clearTimeout(timer));
  });
}

// src/runtime/executors/command.ts
import { execFile as execFile2 } from "node:child_process";
import { isAbsolute as isAbsolute2, resolve as resolve3 } from "node:path";
var DEFAULT_TIMEOUT_MS = 60 * 6e4;
var MAX_OUTPUT_BYTES = 2e7;
function cwdFor(node, options) {
  if (!node.cwd) return options?.defaultCwd;
  if (isAbsolute2(node.cwd)) return node.cwd;
  return options?.defaultCwd ? resolve3(options.defaultCwd, node.cwd) : node.cwd;
}
var runCommand = (node, options) => new Promise((resolvePromise, reject) => {
  const [file, ...args] = node.command;
  execFile2(
    file,
    args,
    {
      cwd: cwdFor(node, options),
      timeout: node.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      shell: false,
      signal: options?.signal
    },
    (error, stdout, stderr) => {
      const err = error;
      if (options?.signal?.aborted) {
        reject(new WorkflowError("RUN_CANCELLED", `node "${node.id}" was cancelled`, { nodeId: node.id }));
        return;
      }
      if (err?.killed) {
        reject(new WorkflowError("NODE_TIMEOUT", `node "${node.id}" command timed out`, { nodeId: node.id }));
        return;
      }
      if (err && typeof err.code !== "number") {
        reject(new WorkflowError("COMMAND_EXECUTION_ERROR", `node "${node.id}": ${err.message}`, { nodeId: node.id }));
        return;
      }
      const exitCode = typeof err?.code === "number" ? err.code : 0;
      resolvePromise({ exitCode, ok: exitCode === 0, stdout: String(stdout), stderr: String(stderr) });
    }
  );
});

// src/runtime/executors/condition.ts
function selectEdge(node, state) {
  const ctx = conditionContext(state);
  let fallback = null;
  for (const edge of node.edges) {
    if (!edge.condition) {
      fallback = edge;
      continue;
    }
    let matched;
    try {
      matched = evaluateCondition(edge.condition, ctx);
    } catch (e) {
      throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${node.id}": ${e.message}`, {
        nodeId: node.id,
        when: edge.when
      });
    }
    if (matched) return edge;
  }
  if (fallback) return fallback;
  throw new WorkflowError("WORKFLOW_ROUTING_ERROR", `node "${node.id}": no edge matched and no fallback edge is defined`, {
    nodeId: node.id
  });
}

// src/runtime/engine.ts
function sentBack(state, nodeId2) {
  const previous = [...state.history].reverse().find((h) => h.nodeId !== nodeId2);
  if (!previous) return "";
  const output = previous.output;
  let signal = "";
  if (output && typeof output === "object") {
    const o = output;
    if (o.ok === false) signal = typeof o.exitCode === "number" ? ` (exit ${o.exitCode})` : " (failed)";
    else if (typeof o.verdict === "string" && o.verdict !== "approved") signal = ` (${o.verdict})`;
    else if (o.passed === false) signal = " (tests failed)";
  }
  return `; last sent back by "${previous.nodeId}"${signal}`;
}
function costOfStep(usage) {
  if (!usage) return 0;
  return costForUsage(
    tierOf(usage.model),
    { input: usage.inputTokens, output: usage.outputTokens, cacheRead: usage.cacheReadTokens },
    { model: usage.model }
  );
}
function renderCommand(command, ctx, nodeId2) {
  return command.map((arg) => {
    if (!arg.includes("{{")) return arg;
    try {
      return renderTemplate(arg, ctx);
    } catch (e) {
      throw new WorkflowError(
        "WORKFLOW_ROUTING_ERROR",
        `node "${nodeId2}": ${e instanceof TemplateError ? e.message : String(e)}`,
        { nodeId: nodeId2 }
      );
    }
  });
}
async function runWorkflow(workflow, opts) {
  const now = opts.now ?? Date.now;
  const emit = (e) => opts.emit?.(e);
  const executionId = opts.executionId ?? randomUUID();
  const state = createState(executionId, workflow.id, opts.input ?? {}, opts.resume);
  const startNodeId = opts.resume?.startNodeId ?? workflow.entry;
  const loadAgent = opts.loadAgent ?? getAgent;
  const execCommand = opts.runCommand ?? runCommand;
  const maxSteps = workflow.maxWorkflowSteps;
  const maxVisits = workflow.maxVisits;
  const maxCost = workflow.maxCostUsd;
  let spentUsd = state.history.reduce((sum, step) => sum + costOfStep(step.usage), 0);
  function halt(code, message, nodeId2) {
    if (state.status !== "running") return;
    state.status = "failed";
    state.error = { code, message };
    emit({ type: "workflow.failed", executionId, at: now(), code, message, nodeId: nodeId2 });
  }
  async function runFrom(startId, stopAt) {
    let currentId = startId;
    for (; ; ) {
      if (state.status !== "running") return;
      if (opts.signal?.aborted) return halt("RUN_CANCELLED", "run cancelled", currentId);
      if (currentId === stopAt) return;
      const node = findNode(workflow, currentId);
      if (!node) return halt("WORKFLOW_ROUTING_ERROR", `node "${currentId}" does not exist`, currentId);
      if (node.type === "terminal") {
        state.status = node.status;
        emit({ type: "workflow.completed", executionId, at: now(), status: node.status, terminalNodeId: node.id });
        return;
      }
      const visit = state.visitCounts[node.id] = (state.visitCounts[node.id] ?? 0) + 1;
      state.stepCount += 1;
      if (maxVisits > 0 && visit > maxVisits) {
        return halt(
          "LOOP_LIMIT_EXCEEDED",
          `node "${node.id}" ran ${visit} times (max ${maxVisits})${sentBack(state, node.id)}`,
          node.id
        );
      }
      if (maxSteps > 0 && state.stepCount > maxSteps) {
        return halt("LOOP_LIMIT_EXCEEDED", `workflow exceeded ${maxSteps} steps`, node.id);
      }
      const stepIndex = state.stepCount - 1;
      const startedAt = now();
      emit({ type: "node.started", executionId, at: startedAt, nodeId: node.id, stepIndex, visit });
      if (opts.workspace && !existsSync7(opts.workspace.root)) {
        return halt(
          "WORKSPACE_ERROR",
          `this run's worktree is gone (${opts.workspace.root}); it was removed while the run was going`,
          node.id
        );
      }
      let input = null;
      let output = null;
      let usage;
      let toolCalls;
      try {
        if (node.type === "agent") {
          const res = await executeAgentNode(node, state, {
            provider: opts.provider,
            loadAgent,
            workspace: opts.workspace ?? null,
            maxToolIterations: opts.maxToolIterations,
            claudeCode: opts.claudeCode,
            signal: opts.signal,
            onToolCall: (call) => emit({
              type: "tool.called",
              executionId,
              at: now(),
              nodeId: node.id,
              stepIndex,
              tool: call.tool,
              ok: call.ok,
              summary: call.result.split("\n")[0].slice(0, 200),
              durationMs: call.durationMs
            })
          });
          input = res.input;
          output = res.output;
          usage = res.usage;
          toolCalls = res.toolCalls.length ? res.toolCalls : void 0;
        } else if (node.type === "command") {
          const command = renderCommand(node.command, conditionContext(state), node.id);
          input = command;
          output = await execCommand({ ...node, command }, { defaultCwd: opts.workspace?.root, signal: opts.signal });
        } else if (node.type === "parallel") {
          input = { branches: node.branches, join: node.join };
          for (const branch of node.branches) {
            emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: branch, label: "parallel" });
          }
          const settled = await Promise.allSettled(node.branches.map((branch) => runFrom(branch, node.join)));
          const crashed = settled.find((r) => r.status === "rejected");
          if (crashed?.status === "rejected") throw crashed.reason;
          if (state.status !== "running") return;
        }
      } catch (e) {
        const code = e instanceof WorkflowError ? e.code : "MODEL_EXECUTION_ERROR";
        const message = e.message;
        const finishedAt2 = now();
        const progress = e instanceof WorkflowError ? e.detail : void 0;
        const step2 = {
          nodeId: node.id,
          stepIndex,
          visit,
          startedAt,
          finishedAt: finishedAt2,
          status: "failed",
          input,
          output: null,
          error: { code, message },
          toolCalls: progress?.toolCalls ?? toolCalls,
          usage: progress?.usage
        };
        state.history.push(step2);
        opts.onStep?.(step2);
        spentUsd += costOfStep(step2.usage);
        emit({ type: "node.failed", executionId, at: finishedAt2, nodeId: node.id, stepIndex, code, message });
        return halt(code, message, node.id);
      }
      if (node.type !== "condition" && node.type !== "parallel") state.outputs[node.id] = output;
      const finishedAt = now();
      const step = {
        nodeId: node.id,
        stepIndex,
        visit,
        startedAt,
        finishedAt,
        status: "completed",
        input,
        output,
        usage,
        toolCalls
      };
      state.history.push(step);
      opts.onStep?.(step);
      emit({ type: "node.output", executionId, at: finishedAt, nodeId: node.id, stepIndex, output });
      emit({
        type: "node.completed",
        executionId,
        at: finishedAt,
        nodeId: node.id,
        stepIndex,
        durationMs: finishedAt - startedAt,
        usage
      });
      spentUsd += costOfStep(usage);
      if (maxCost > 0 && spentUsd > maxCost) {
        return halt(
          "BUDGET_EXCEEDED",
          `run spent $${spentUsd.toFixed(2)}, over this workflow's $${maxCost.toFixed(2)} budget`,
          node.id
        );
      }
      if (node.type === "parallel") {
        emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: node.join, label: "join" });
        currentId = node.join;
        continue;
      }
      let edge;
      try {
        edge = selectEdge(node, state);
      } catch (e) {
        const code = e instanceof WorkflowError ? e.code : "WORKFLOW_ROUTING_ERROR";
        return halt(code, e.message, node.id);
      }
      emit({ type: "edge.selected", executionId, at: now(), from: node.id, to: edge.to, label: edge.label });
      currentId = edge.to;
    }
  }
  emit({ type: "workflow.started", executionId, at: now(), workflowId: workflow.id, entry: startNodeId });
  await runFrom(startNodeId, null);
  return state;
}

// src/runtime/workspace.ts
import { execFileSync } from "node:child_process";
import { existsSync as existsSync8, mkdirSync as mkdirSync7, rmSync as rmSync4 } from "node:fs";
import { homedir as homedir4 } from "node:os";
import { join as join8, resolve as resolve4 } from "node:path";
var MAX_LISTED_FILES = 200;
function workspacesDir() {
  return join8(process.env.GATE_HOME || join8(homedir4(), ".gate"), "workspaces");
}
function git(cwd, args) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1e7 }).trim();
  } catch (e) {
    const err = e;
    throw new WorkflowError("WORKSPACE_ERROR", `git ${args[0]} failed: ${(err.stderr || err.message).trim().slice(0, 400)}`);
  }
}
function createRunWorkspace(spec, executionId) {
  const repo = resolve4(spec.repo.replace(/^~(?=\/|$)/, homedir4()));
  if (!existsSync8(repo)) {
    throw new WorkflowError("WORKSPACE_ERROR", `workspace repo "${spec.repo}" does not exist`);
  }
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
  } catch {
    throw new WorkflowError("WORKSPACE_ERROR", `workspace repo "${spec.repo}" is not a git repository`);
  }
  const baseRef = spec.baseRef ?? "HEAD";
  const branch = `${spec.branchPrefix ?? "gate/run"}-${executionId.slice(0, 8)}`;
  const root = join8(workspacesDir(), executionId);
  mkdirSync7(workspacesDir(), { recursive: true, mode: 448 });
  if (existsSync8(root)) rmSync4(root, { recursive: true, force: true });
  git(repo, ["worktree", "add", "-b", branch, root, baseRef]);
  return { root, repo, branch, baseRef };
}
function summarizeWorkspace(ws) {
  let changedFiles = [];
  let commit = null;
  try {
    changedFiles = git(ws.root, ["status", "--porcelain"]).split("\n").filter(Boolean).slice(0, MAX_LISTED_FILES).map((l) => l.trim());
    commit = git(ws.root, ["rev-parse", "HEAD"]);
  } catch {
  }
  return { ...ws, changedFiles, commit };
}
var MAX_DIFF_BYTES = 4e6;
function readRunDiff(root) {
  if (!existsSync8(root)) throw new WorkflowError("WORKSPACE_ERROR", "this run's worktree is gone");
  git(root, ["add", "-N", "."]);
  const diff = git(root, ["diff"]);
  return diff.length > MAX_DIFF_BYTES ? { diff: diff.slice(0, MAX_DIFF_BYTES), truncated: true } : { diff, truncated: false };
}

// src/providers/anthropic-shape.ts
function toAnthropicMessage(m) {
  if (typeof m.content === "string") return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: m.content.map((b) => {
      if (b.type === "tool_use") return { type: "tool_use", id: b.id, name: b.name, input: b.input };
      if (b.type === "tool_result") {
        return { type: "tool_result", tool_use_id: b.toolUseId, content: b.content, is_error: b.isError ?? false };
      }
      return { type: "text", text: b.text };
    })
  };
}
function toAnthropicBody(req) {
  const body = {
    model: req.model,
    max_tokens: req.maxTokens ?? 8192,
    messages: req.messages.map(toAnthropicMessage)
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) {
    body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  }
  return body;
}
function fromAnthropicMessage(json, requestedModel, routedModel) {
  const content = [];
  for (const block of json.content ?? []) {
    if (block?.type === "text" && typeof block.text === "string") {
      content.push({ type: "text", text: block.text });
    } else if (block?.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
      content.push({ type: "tool_use", id: block.id, name: block.name, input: block.input });
    }
  }
  const toolUses = content.filter((b) => b.type === "tool_use");
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
  if (!text && !toolUses.length) throw new WorkflowError("MODEL_EXECUTION_ERROR", "model returned no content");
  return {
    text,
    content,
    toolUses,
    stopReason: json.stop_reason ?? null,
    model: routedModel || json.model || requestedModel,
    usage: {
      inputTokens: json.usage?.input_tokens ?? 0,
      outputTokens: json.usage?.output_tokens ?? 0,
      cacheReadTokens: json.usage?.cache_read_input_tokens ?? 0
    }
  };
}

// src/client/http-provider.ts
var HttpGateProvider = class {
  constructor(gatewayUrl2, apiKey) {
    this.gatewayUrl = gatewayUrl2;
    this.apiKey = apiKey;
  }
  gatewayUrl;
  apiKey;
  async execute(req) {
    if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
    const body = toAnthropicBody(req);
    const executionId = req.context?.executionId ?? null;
    const headers = {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`
    };
    if (executionId) headers["x-gate-session"] = `workflow:${executionId}`;
    if (req.effort) headers["x-gate-effort"] = req.effort;
    let res;
    try {
      res = await fetch(`${this.gatewayUrl}/v1/messages`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: req.signal
      });
    } catch (e) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      throw new WorkflowError("MODEL_EXECUTION_ERROR", `cannot reach the gateway: ${e.message}`, {
        model: req.model
      });
    }
    const raw = await res.text();
    if (!res.ok) {
      if (req.signal?.aborted) throw new WorkflowError("RUN_CANCELLED", "run cancelled");
      if (res.status === 401 || res.status === 403) {
        throw new WorkflowError("MODEL_EXECUTION_ERROR", "the gateway refused this API key \u2014 run `gate login` again", {
          status: res.status
        });
      }
      throw new WorkflowError("MODEL_EXECUTION_ERROR", `model call failed (${res.status}): ${truncate2(raw)}`, {
        status: res.status,
        model: req.model
      });
    }
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new WorkflowError("MODEL_EXECUTION_ERROR", "model returned a non-JSON response");
    }
    return fromAnthropicMessage(json, req.model, res.headers.get("x-gate-model"));
  }
};
function truncate2(s) {
  return s.length > 300 ? `${s.slice(0, 300)}\u2026` : s;
}

// src/client/reporter.ts
var FLUSH_INTERVAL_MS = 1e3;
var HEARTBEAT_MS = 5e3;
var MAX_BUFFERED_EVENTS = 2e3;
var MAX_BUFFERED_STEPS = 200;
var RunReporter = class {
  constructor(client, executionId, onCancel) {
    this.client = client;
    this.executionId = executionId;
    this.onCancel = onCancel;
  }
  client;
  executionId;
  onCancel;
  events = [];
  steps = [];
  timer = null;
  inFlight = false;
  lastSentAt = Date.now();
  stopped = false;
  /** The flag stays set on the server; the run only needs telling once. */
  cancelSeen = false;
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.timer.unref?.();
  }
  event(event) {
    if (this.events.length >= MAX_BUFFERED_EVENTS) this.events.shift();
    this.events.push(event);
  }
  step(step) {
    if (this.steps.length >= MAX_BUFFERED_STEPS) this.steps.shift();
    this.steps.push(step);
  }
  /** Sends what is buffered. Safe to call concurrently; overlapping calls no-op. */
  async flush() {
    if (this.inFlight || this.stopped) return;
    const idle = !this.events.length && !this.steps.length;
    if (idle && Date.now() - this.lastSentAt < HEARTBEAT_MS) return;
    const events = this.events;
    const steps = this.steps;
    this.events = [];
    this.steps = [];
    this.inFlight = true;
    try {
      const res = await this.client.report(this.executionId, { events, steps });
      this.lastSentAt = Date.now();
      if (res.cancelRequested && !this.cancelSeen) {
        this.cancelSeen = true;
        this.onCancel();
      }
    } catch {
      this.events = [...events, ...this.events].slice(-MAX_BUFFERED_EVENTS);
      this.steps = [...steps, ...this.steps].slice(-MAX_BUFFERED_STEPS);
    } finally {
      this.inFlight = false;
    }
  }
  /** Final flush, then stop reporting. Called once the engine has settled. */
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (let attempt = 0; attempt < 4 && (this.inFlight || this.events.length || this.steps.length); attempt++) {
      if (this.inFlight) {
        await new Promise((resolve7) => setTimeout(resolve7, 100));
        continue;
      }
      this.lastSentAt = 0;
      await this.flush();
    }
    this.stopped = true;
  }
};

// src/client/run.ts
function isPathLike(value) {
  return value.startsWith("/") || value.startsWith("~") || value.startsWith(".") || value.includes("/");
}
function resolveRepo(workflow, input, cwd, repos = {}) {
  const given = typeof input.repo === "string" ? input.repo.trim() : "";
  const pinned = workflow.workspace?.repo?.trim() ?? "";
  const named = given || pinned;
  if (named && !isPathLike(named)) {
    const mapped = repos[named];
    if (mapped) return resolve5(mapped.replace(/^~(?=\/|$)/, homedir5()));
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in the connected repository "${named}", which this machine has no checkout for \u2014 run \`gate repo ${named} /path/to/your/clone\` once, or pass --input repo=/path/to/your/clone`
    );
  }
  if (named) return resolve5(named.replace(/^~(?=\/|$)/, homedir5()));
  try {
    return execFileSync2("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
  } catch {
    throw new WorkflowError(
      "WORKSPACE_ERROR",
      `this workflow works in a repository, and ${cwd} is not one \u2014 run it from a checkout, or pass --input repo=/path/to/repo`
    );
  }
}
async function runLocal(client, opts) {
  const scope = cacheScope(opts.team);
  const workflow = getWorkflow(opts.workflowId, scope);
  const input = { ...opts.input };
  let workspace = null;
  let repo = null;
  if (workflow.workspace) {
    repo = resolveRepo(workflow, input, opts.cwd, opts.repos ?? {});
    input.repo = repo;
  }
  const executionId = await client.startRun({
    workflowId: workflow.id,
    input,
    client: { host: hostname2(), repo: repo ?? void 0, version: CLI_VERSION }
  });
  const controller = new AbortController();
  const reporter = new RunReporter(client, executionId, () => {
    opts.onNotice?.("stop requested from the dashboard");
    controller.abort();
  });
  try {
    if (workflow.workspace) {
      workspace = createRunWorkspace({ ...workflow.workspace, repo }, executionId);
    }
  } catch (e) {
    const error = { code: e instanceof WorkflowError ? e.code : "WORKSPACE_ERROR", message: e.message };
    await client.finish(executionId, { status: "failed", error, stepCount: 0 }).catch(() => {
    });
    throw e;
  }
  reporter.start();
  const onInterrupt = () => {
    opts.onNotice?.("stopping\u2026");
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onInterrupt);
  let state;
  try {
    state = await runWorkflow(workflow, {
      provider: new HttpGateProvider(client.gatewayUrl, client.key),
      input,
      executionId,
      workspace,
      loadAgent: (id) => getAgent(id, scope),
      // A node that runs as a spawned Claude Code talks to the same gateway
      // with the same key, so its calls are metered like every other call.
      claudeCode: { gatewayUrl: client.gatewayUrl, authToken: client.key },
      emit: (event) => {
        reporter.event(event);
        opts.onEvent?.(event);
      },
      onStep: (step) => reporter.step(step),
      signal: controller.signal
    });
  } finally {
    process.off("SIGINT", onInterrupt);
    process.off("SIGTERM", onInterrupt);
  }
  await reporter.stop();
  const summary = workspace ? summarizeWorkspace(workspace) : null;
  let diff = null;
  if (workspace) {
    try {
      diff = readRunDiff(workspace.root).diff;
    } catch {
    }
  }
  await client.finish(executionId, {
    status: state.status === "completed" ? "completed" : "failed",
    error: state.error ?? null,
    stepCount: state.stepCount,
    workspace: summary,
    diff
  }).catch((e) => opts.onNotice?.(`could not report the run's outcome: ${e.message}`));
  return { executionId, state, workspace };
}

// src/client/cli.ts
var USAGE = `gate ${CLI_VERSION} \u2014 run your team's agent workflows on this machine

  gate install                                  put gate itself on your PATH
  gate login <token>                            connect this machine (one token from your dashboard)
       --url <gate-url> --key <api-key>         \u2026or the two halves separately
  gate whoami                                   who this key belongs to
  gate pull                                     refresh your team's definitions
  gate list                                     what you can run, and what it needs
  gate agents                                   the agents your team's pipelines use
  gate show <workflow|agent-id>                 print a definition as it is on the server
  gate push <file\u2026> [--replace]                 save definitions to your team (needs an author key)
  gate run <workflow> [task\u2026]                   run one here, in this repository
       --input key=value                        (repeat for more than one input)
       --yes                                    skip the first-run approval prompt
       --quiet                                  only print the outcome
  gate repo [<id> <path>]                       point a pinned repository at your clone
  gate reset [--team]                           disconnect this machine (or wipe the team's definitions)
  gate status [--limit n]                       your team's recent runs
  gate cancel <execution-id>                    ask a run to stop

Environment: GATE_URL and GATE_KEY override the saved login.`;
var VALUE_FLAGS = /* @__PURE__ */ new Set(["url", "key", "token", "input", "limit", "team", "dir"]);
function parseArgs(argv) {
  const [command = "help", ...rest] = argv;
  const positional = [];
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    const collect = (value) => flags[name] = name === "input" && typeof flags.input === "string" ? `${flags.input} ${value}` : value;
    if (inline !== void 0) {
      collect(inline);
      continue;
    }
    const next = rest[i + 1];
    if (VALUE_FLAGS.has(name) && next !== void 0 && !next.startsWith("--")) {
      collect(next);
      i++;
    } else {
      flags[name] = true;
    }
  }
  return { command, positional, flags };
}
function die(message) {
  console.error(message);
  process.exit(1);
}
function connect() {
  const config = readConfig();
  if (!config) {
    die(
      "not connected \u2014 run `/gate:login <token>` in Claude Code, with the token from your gate dashboard's Team page (or `gate login <token>` in a terminal)"
    );
  }
  return new GateClient(config);
}
async function sync(client, team, quiet = false) {
  const known = team ? readManifest(team) : null;
  try {
    const bundle = await client.bundle(known?.hash);
    if (!bundle) return known;
    const manifest = writeBundle(bundle, client.url);
    if (!quiet && known && known.hash !== manifest.hash) {
      console.error(`# definitions updated (${manifest.workflows.length} workflows)`);
    }
    for (const error of bundle.errors) {
      console.error(`# warning: workflow "${error.id}" is broken on the server \u2014 ${error.message}`);
    }
    return manifest;
  } catch (e) {
    if (known) {
      if (!quiet) console.error(`# using the definitions pulled ${new Date(known.pulledAt).toLocaleString()} (${e.message})`);
      return known;
    }
    throw e;
  }
}
async function teamOf(client, config) {
  if (config.team) return config.team;
  const me = await client.me();
  writeConfig({ ...config, team: me.team.id, user: me.user?.email });
  return me.team.id;
}
async function cmdLogin(args) {
  const flags = args.flags;
  const [positional] = args.positional;
  let url = typeof flags.url === "string" ? flags.url.replace(/\/+$/, "") : "";
  let key = typeof flags.key === "string" ? flags.key : "";
  const token = positional ?? (typeof flags.token === "string" ? flags.token : "");
  if (token) {
    if (!looksLikeConnectionToken(token)) {
      die(
        token.startsWith("gate_") ? "that is an API key, not a connection token \u2014 copy the whole `/gate:login \u2026` line from your dashboard, or pass --url and --key" : `that does not look like a gate token: ${token.slice(0, 12)}\u2026`
      );
    }
    try {
      const connection = decodeConnectionToken(token);
      url = connection.url;
      key = connection.key;
    } catch (e) {
      die(e.message);
    }
  }
  if (!url || !key) die("usage: gate login <token>   (or: gate login --url <gate-url> --key <api-key>)");
  const client = new GateClient({ url, key });
  const me = await client.me();
  writeConfig({ url, key, team: me.team.id, user: me.user?.email });
  console.log(`connected to ${url} as ${me.user?.email ?? "this key"} \xB7 team ${me.team.name}`);
  const manifest = await sync(client, me.team.id, true);
  console.log(`${manifest.workflows.length} workflow(s) available \u2014 \`gate list\` to see them`);
  return 0;
}
function cmdInstall(args) {
  const target = typeof args.flags.dir === "string" ? args.flags.dir : join9(homedir6(), ".local", "bin");
  const script = process.argv[1];
  const shim = join9(target, "gate");
  try {
    mkdirSync8(target, { recursive: true });
    writeFileSync6(shim, `#!/bin/sh
exec node "${script}" "$@"
`, { mode: 493 });
  } catch (e) {
    die(`could not write ${shim}: ${e.message}`);
  }
  console.log(`installed ${shim}`);
  const path = (process.env.PATH ?? "").split(":");
  if (!path.includes(target)) {
    console.log(`${target} is not on your PATH \u2014 add it, or run gate as ${shim}`);
    console.log(`  echo 'export PATH="${target}:$PATH"' >> ~/.zshrc`);
  }
  return 0;
}
async function cmdWhoami() {
  const client = connect();
  const me = await client.me();
  console.log(`${me.user?.email ?? "(key with no owner)"} \xB7 team ${me.team.name} (${me.team.id}) \xB7 ${client.url}`);
  console.log(`scopes: ${me.scopes.join(", ")}`);
  console.log(
    `gate ${CLI_VERSION} here \xB7 ${me.server?.version ?? "unknown"} there` + (me.server?.minClientVersion ? ` (needs ${me.server.minClientVersion}+)` : "")
  );
  return 0;
}
async function cmdList() {
  const client = connect();
  const config = readConfig();
  const manifest = await sync(client, await teamOf(client, config));
  if (!manifest.workflows.length) {
    console.log("no workflows defined for your team yet");
    return 0;
  }
  for (const wf of manifest.workflows) {
    const inputs = wf.inputs.length ? wf.inputs.join(", ") : "none";
    const where = !wf.workspace ? "no workspace (agents cannot touch files)" : wf.workspace.repo ? `git worktree of ${wf.workspace.repo}` : "git worktree of the repo you run it in";
    console.log(wf.id);
    console.log(`  ${wf.name}${wf.description ? ` \u2014 ${wf.description}` : ""}`);
    console.log(`  input: ${inputs} \xB7 ${wf.nodeCount} nodes \xB7 ${where}`);
  }
  return 0;
}
async function cmdAgents() {
  const client = connect();
  const config = readConfig();
  const team = await teamOf(client, config);
  await sync(client, team, true);
  const { agents, errors } = listAgents(cacheScope(team));
  for (const agent of agents) {
    const how = agent.executor === "claude-code" ? "claude-code" : `tools: ${agent.tools.join(", ") || "none"}`;
    console.log(`${agent.id}`);
    console.log(`  ${agent.name} \xB7 ${agent.model}${agent.effort ? `/${agent.effort}` : ""} \xB7 ${how}`);
    console.log(`  inputs: ${agent.inputs.join(", ") || "none"} \xB7 output: ${agent.output.type}`);
  }
  for (const error of errors) console.log(`${error.id}
  BROKEN \u2014 ${error.message}`);
  return 0;
}
async function cmdShow(args) {
  const [id] = args.positional;
  if (!id) die("usage: gate show <workflow-id|agent-id>");
  const client = connect();
  const config = readConfig();
  const team = await teamOf(client, config);
  await sync(client, team, true);
  const scope = cacheScope(team);
  try {
    console.log(readWorkflowSource(id, scope));
  } catch {
    try {
      console.log(readAgentSource(id, scope));
    } catch {
      die(`no workflow or agent "${id}" for your team`);
    }
  }
  return 0;
}
async function cmdPush(args) {
  const files = args.positional;
  if (!files.length) die("usage: gate push <file\u2026>   (.md is an agent, .yaml a workflow)");
  const client = connect();
  const config = readConfig();
  await teamOf(client, config);
  const items = files.map((file) => {
    const name = basename(file);
    const kind = name.endsWith(".md") ? "agent" : "workflow";
    if (!/\.(md|ya?ml)$/.test(name)) die(`${file}: expected a .md agent or a .yaml workflow`);
    return { kind, id: name.replace(/\.(md|ya?ml)$/, ""), file };
  });
  items.sort((a, b) => a.kind === b.kind ? 0 : a.kind === "agent" ? -1 : 1);
  let failed = 0;
  for (const item of items) {
    let source;
    try {
      source = readFileSync6(item.file, "utf8");
    } catch (e) {
      console.error(`${item.file}: ${e.message}`);
      failed++;
      continue;
    }
    try {
      const res = await client.saveDefinition({
        kind: item.kind,
        id: item.id,
        source,
        replace: args.flags.replace === true
      });
      console.log(`${res.replaced ? "replaced" : "saved"} ${item.kind} ${item.id}`);
    } catch (e) {
      console.error(`${item.kind} ${item.id}: ${e.message}`);
      failed++;
    }
  }
  if (!failed) console.log("`gate list` now shows them, on every machine on your team");
  return failed ? 1 : 0;
}
async function cmdPull() {
  const client = connect();
  const config = readConfig();
  const manifest = await sync(client, await teamOf(client, config), true);
  console.log(`pulled ${manifest.workflows.length} workflow(s) for team ${manifest.team} from ${manifest.from}`);
  return 0;
}
function describeCapabilities(workflowId, team) {
  const scope = cacheScope(team);
  const workflow = getWorkflow(workflowId, scope);
  const lines = [];
  for (const node of workflow.nodes) {
    if (node.type === "command") lines.push(`  runs: ${node.command.join(" ")}`);
    if (node.type === "agent") {
      try {
        const agent = getAgent(node.agent, scope);
        const how = agent.executor === "claude-code" ? "a headless Claude Code session" : `tools: ${agent.tools.join(", ") || "none"}`;
        lines.push(`  agent ${node.agent}: ${how}`);
      } catch {
        lines.push(`  agent ${node.agent}: (definition missing)`);
      }
    }
  }
  return lines;
}
async function confirmTrust(workflowId, sha, team, assumeYes) {
  if (isTrusted(workflowId, sha)) return true;
  if (assumeYes) {
    trustWorkflow(workflowId, sha);
    return true;
  }
  const lines = describeCapabilities(workflowId, team);
  console.error(`"${workflowId}" has not been run on this machine at this version. It will:`);
  for (const line of lines) console.error(line);
  console.error("  \u2026in a git worktree of this repository, on its own branch.");
  if (!process.stdin.isTTY) {
    console.error("Refusing to run unattended without approval \u2014 re-run with --yes if this is expected.");
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = (await rl.question("Run it? [y/N] ")).trim().toLowerCase();
  rl.close();
  if (answer !== "y" && answer !== "yes") return false;
  trustWorkflow(workflowId, sha);
  return true;
}
function parseInputs(flags, trailing) {
  const input = {};
  if (typeof flags.input === "string") {
    for (const pair of flags.input.split("\0")) {
      const [key, ...rest] = pair.split("=");
      if (!key || !rest.length) die(`--input must be key=value (got "${pair}")`);
      input[key] = rest.join("=");
    }
  }
  const task = trailing.join(" ").trim();
  if (task && input.task === void 0) input.task = task;
  return input;
}
function printEvent(event) {
  switch (event.type) {
    case "node.started":
      console.error(`\u25B8 ${event.nodeId}`);
      break;
    case "tool.called":
      console.error(`  ${event.ok ? "\xB7" : "\u2717"} ${event.tool} ${event.summary}`);
      break;
    case "node.completed":
      console.error(`  \u2713 ${event.nodeId} (${Math.round(event.durationMs / 1e3)}s)`);
      break;
    case "node.failed":
      console.error(`  \u2717 ${event.nodeId}: ${event.message}`);
      break;
    case "edge.selected":
      console.error(`  \u2192 ${event.to}${event.label ? ` \xB7 ${event.label}` : ""}`);
      break;
    default:
      break;
  }
}
async function cmdRun(args) {
  const [workflowId, ...trailing] = args.positional;
  if (!workflowId) die("usage: gate run <workflow> [task\u2026]  \xB7  `gate list` shows what you can run");
  const client = connect();
  const config = readConfig();
  const team = await teamOf(client, config);
  const manifest = await sync(client, team, true);
  const entry = manifest.workflows.find((w) => w.id === workflowId);
  if (!entry) {
    die(`no workflow "${workflowId}" for your team \u2014 \`gate list\` shows what there is`);
  }
  if (!await confirmTrust(workflowId, entry.sha, team, args.flags.yes === true)) return 1;
  const quiet = args.flags.quiet === true;
  const input = parseInputs(args.flags, trailing);
  const result = await runLocal(client, {
    workflowId,
    input,
    cwd: process.cwd(),
    team,
    repos: repoPaths(),
    onEvent: quiet ? void 0 : printEvent,
    onNotice: (message) => console.error(`# ${message}`)
  });
  const { state, workspace, executionId } = result;
  console.log(`${state.status}: ${workflowId} (${executionId})`);
  if (state.error) console.log(`${state.error.code}: ${state.error.message}`);
  if (workspace) {
    console.log(`branch ${workspace.branch} in ${workspace.root}`);
    console.log(`review it with: git -C ${workspace.root} diff`);
  }
  console.log(`${client.url}/executions/${executionId}`);
  return state.status === "completed" ? 0 : 1;
}
function cmdRepo(args) {
  const [id, path] = args.positional;
  if (!id) {
    const repos = repoPaths();
    const entries = Object.entries(repos);
    if (!entries.length) {
      console.log("no repositories mapped \u2014 `gate repo <id> /path/to/your/clone` when a workflow asks for one");
      return 0;
    }
    for (const [key, value] of entries) console.log(`${key}  ${value}`);
    return 0;
  }
  if (!path) die(`usage: gate repo ${id} /path/to/your/clone`);
  setRepoPath(id, resolve6(path));
  console.log(`${id} \u2192 ${resolve6(path)}`);
  return 0;
}
async function cmdReset(args) {
  const wipeTeam = args.flags.team === true;
  if (wipeTeam) {
    const client = connect();
    const config = readConfig();
    const team = await teamOf(client, config);
    const manifest = readManifest(team);
    const count = manifest?.workflows.length ?? 0;
    if (!process.stdin.isTTY) {
      die("refusing to delete a team's definitions unattended \u2014 run this in a terminal");
    }
    console.error(
      `This deletes every agent and workflow team "${team}" owns (${count} workflow(s)), for everyone on it.`
    );
    console.error("Runs already recorded, their worktrees and your API keys are not touched.");
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    const answer = (await rl.question(`Type the team name to confirm: `)).trim();
    rl.close();
    if (answer !== team) {
      console.log("nothing deleted");
      return 1;
    }
    const removed2 = await client.wipeTeamDefinitions();
    console.log(`deleted ${removed2.agents} agent(s) and ${removed2.workflows} workflow(s) from team ${team}`);
    console.log("(anything the default team shares is untouched \u2014 it is not this team's to delete)");
  }
  const removed = clearLocalState();
  for (const line of removed) console.log(line);
  console.log("this machine is disconnected \u2014 `/gate:login <token>` connects it again");
  return 0;
}
async function cmdStatus(args) {
  const client = connect();
  const limit = Number(args.flags.limit ?? 10);
  const runs = await client.listRuns(Number.isFinite(limit) ? limit : 10);
  if (!runs.length) {
    console.log("no runs yet");
    return 0;
  }
  for (const run of runs) {
    const where = run.origin === "local" ? run.client?.host ?? "a machine" : "the server";
    console.log(
      `${run.id.slice(0, 8)}  ${String(run.status).padEnd(9)} ${run.workflowId}  ${new Date(run.startedAt).toLocaleString()}  on ${where}`
    );
  }
  return 0;
}
async function cmdCancel(args) {
  const [id] = args.positional;
  if (!id) die("usage: gate cancel <execution-id>");
  const client = connect();
  const res = await client.cancel(id);
  console.log(res.requested ? `asked ${id} to stop; it settles on its next report` : `nothing to stop \u2014 ${res.reason ?? "run not found"}`);
  return res.requested ? 0 : 1;
}
async function main(argv) {
  const args = parseArgs(argv);
  try {
    switch (args.command) {
      case "install":
        return cmdInstall(args);
      case "login":
        return await cmdLogin(args);
      case "whoami":
        return await cmdWhoami();
      case "pull":
        return await cmdPull();
      case "list":
        return await cmdList();
      case "agents":
        return await cmdAgents();
      case "show":
        return await cmdShow(args);
      case "push":
        return await cmdPush(args);
      case "run":
        return await cmdRun(args);
      case "repo":
        return cmdRepo(args);
      case "reset":
        return await cmdReset(args);
      case "status":
        return await cmdStatus(args);
      case "cancel":
        return await cmdCancel(args);
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        console.error(`unknown command "${args.command}"

${USAGE}`);
        return 1;
    }
  } catch (e) {
    if (e instanceof GateApiError) {
      const hint = e.code === "NO_API_KEY" || e.code === "INVALID_API_KEY" ? "\nRun `/gate:login <token>` with the token from your dashboard's Team page." : "";
      console.error(`${e.message}${hint}`);
      return 1;
    }
    console.error(e.message);
    return 1;
  }
}

// src/client/entry.ts
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
);
/*! Bundled license information:

js-yaml/dist/js-yaml.mjs:
  (*! js-yaml 5.4.1 https://github.com/nodeca/js-yaml @license MIT *)
*/
