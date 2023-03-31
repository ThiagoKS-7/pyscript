import toml from '@hoodmane/toml-j0.4';
import { getLogger } from './logger';
import { version } from './version';
import { getAttribute, readTextFromPath, htmlDecode, createDeprecationWarning } from './utils';
import { UserError, ErrorCode } from './exceptions';

const logger = getLogger('py-config');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AppConfig extends Record<string, any> {
    name?: string;
    description?: string;
    version?: string;
    schema_version?: number;
    type?: string;
    author_name?: string;
    author_email?: string;
    license?: string;
    interpreters?: InterpreterConfig[];
    // TODO: Remove `runtimes` once the deprecation cycle is over
    runtimes?: InterpreterConfig[];
    packages?: string[];
    fetch?: FetchConfig[];
    plugins?: string[];
    pyscript?: PyScriptMetadata;
    execution_thread?: string; // "main" or "worker"
}

export type FetchConfig = {
    from?: string;
    to_folder?: string;
    to_file?: string;
    files?: string[];
};

export type InterpreterConfig = {
    src?: string;
    name?: string;
    lang?: string;
};

export type PyScriptMetadata = {
    version?: string;
    time?: string;
};

const allKeys = Object.entries({
    string: ['name', 'description', 'version', 'type', 'author_name', 'author_email', 'license', 'execution_thread'],
    number: ['schema_version'],
    array: ['runtimes', 'interpreters', 'packages', 'fetch', 'plugins'],
});

export const defaultConfig: AppConfig = {
    schema_version: 1,
    type: 'app',
    interpreters: [
        {
            src: 'https://cdn.jsdelivr.net/pyodide/v0.22.1/full/pyodide.js',
            name: 'pyodide-0.22.1',
            lang: 'python',
        },
    ],
    // This is for backward compatibility, we need to remove it in the future
    runtimes: [],
    packages: [],
    fetch: [],
    plugins: [],
    execution_thread: 'main',
};

export function loadConfigFromElement(el: Element): AppConfig {
    let srcConfig: AppConfig;
    let inlineConfig: AppConfig;
    if (el === null) {
        srcConfig = {};
        inlineConfig = {};
    } else {
        const configType = getAttribute(el, 'type') || 'toml';
        srcConfig = extractFromSrc(el, configType);
        inlineConfig = extractFromInline(el, configType);
    }
    srcConfig = mergeConfig(srcConfig, defaultConfig);
    const result = mergeConfig(inlineConfig, srcConfig);
    result.pyscript = {
        version,
        time: new Date().toISOString(),
    };
    return result;
}

function extractFromSrc(el: Element, configType: string) {
    const src = getAttribute(el, 'src');
    if (src) {
        logger.info('loading ', src);
        return validateConfig(readTextFromPath(src), configType);
    }
    return {};
}

function extractFromInline(el: Element, configType: string) {
    if (el.innerHTML !== '') {
        logger.info('loading <py-config> content');
        return validateConfig(htmlDecode(el.innerHTML), configType);
    }
    return {};
}

function fillUserData(inputConfig: AppConfig, resultConfig: AppConfig): AppConfig {
    for (const key in inputConfig) {
        // fill in all extra keys ignored by the validator
        if (!(key in defaultConfig)) {
            // eslint-disable-next-line
            resultConfig[key] = inputConfig[key];
        }
    }
    return resultConfig;
}

function mergeConfig(inlineConfig: AppConfig, externalConfig: AppConfig): AppConfig {
    if (Object.keys(inlineConfig).length === 0 && Object.keys(externalConfig).length === 0) {
        return defaultConfig;
    } else if (Object.keys(inlineConfig).length === 0) {
        return externalConfig;
    } else if (Object.keys(externalConfig).length === 0) {
        return inlineConfig;
    } else {
        let merged: AppConfig = {};

        for (const [keyType, keys] of allKeys) {
            keys.forEach(function (item: string) {
                if (keyType === 'boolean') {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    merged[item] =
                        typeof inlineConfig[item] !== 'undefined' ? inlineConfig[item] : externalConfig[item];
                } else {
                    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                    merged[item] = inlineConfig[item] || externalConfig[item];
                }
            });
        }

        // fill extra keys from external first
        // they will be overridden by inline if extra keys also clash
        merged = fillUserData(externalConfig, merged);
        merged = fillUserData(inlineConfig, merged);

        return merged;
    }
}

function parseConfig(configText: string, configType = 'toml'): AppConfig {
    if (configType === 'toml') {
        // TOML parser is soft and can parse even JSON strings, this additional check prevents it.
        if (configText.trim()[0] === '{') {
            throw new UserError(
                ErrorCode.BAD_CONFIG,
                `The config supplied: ${configText} is an invalid TOML and cannot be parsed`,
            );
        }
        try {
            return toml.parse(configText) as AppConfig;
        } catch (e) {
            const err = e as Error;
            const errMessage: string = err.toString();

            throw new UserError(
                ErrorCode.BAD_CONFIG,
                `The config supplied: ${configText} is an invalid TOML and cannot be parsed: ${errMessage}`,
            );
        }
    } else if (configType === 'json') {
        try {
            return JSON.parse(configText) as AppConfig;
        } catch (e) {
            const err = e as Error;
            const errMessage: string = err.toString();
            throw new UserError(
                ErrorCode.BAD_CONFIG,
                `The config supplied: ${configText} is an invalid JSON and cannot be parsed: ${errMessage}`,
            );
        }
    } else {
        throw new UserError(
            ErrorCode.BAD_CONFIG,
            `The type of config supplied '${configType}' is not supported, supported values are ["toml", "json"]`,
        );
    }
}

function validateConfig(configText: string, configType = 'toml') {
    const config = parseConfig(configText, configType);

    const finalConfig: AppConfig = {};

    for (const [keyType, keys] of allKeys) {
        keys.forEach(function (item: string) {
            if (validateParamInConfig(item, keyType, config)) {
                if (item === 'interpreters') {
                    finalConfig[item] = [];
                    const interpreters = config[item];
                    interpreters.forEach(function (eachInterpreter: InterpreterConfig) {
                        const interpreterConfig: InterpreterConfig = {};
                        for (const eachInterpreterParam in eachInterpreter) {
                            if (validateParamInConfig(eachInterpreterParam, 'string', eachInterpreter)) {
                                // eslint-disable-next-line
                                interpreterConfig[eachInterpreterParam] = eachInterpreter[eachInterpreterParam];
                            }
                        }
                        finalConfig[item].push(interpreterConfig);
                    });
                } else if (item === 'runtimes') {
                    // This code is a bit of a mess, but it's used for backwards
                    // compatibility with the old runtimes config. It should be
                    // removed when we remove support for the old config.
                    // We also need the warning here since we are pushing
                    // runtimes to `interpreter` and we can't show the warning
                    // in main.js
                    createDeprecationWarning(
                        'The configuration option `config.runtimes` is deprecated. ' +
                            'Please use `config.interpreters` instead.',
                        '',
                    );
                    finalConfig['interpreters'] = [];
                    const interpreters = config[item];
                    interpreters.forEach(function (eachInterpreter: InterpreterConfig) {
                        const interpreterConfig: InterpreterConfig = {};
                        for (const eachInterpreterParam in eachInterpreter) {
                            if (validateParamInConfig(eachInterpreterParam, 'string', eachInterpreter)) {
                                // eslint-disable-next-line
                                interpreterConfig[eachInterpreterParam] = eachInterpreter[eachInterpreterParam];
                            }
                        }
                        finalConfig['interpreters'].push(interpreterConfig);
                    });
                } else if (item === 'fetch') {
                    finalConfig[item] = [];
                    const fetchList = config[item];
                    fetchList.forEach(function (eachFetch: FetchConfig) {
                        const eachFetchConfig: FetchConfig = {};
                        for (const eachFetchConfigParam in eachFetch) {
                            const targetType = eachFetchConfigParam === 'files' ? 'array' : 'string';
                            if (validateParamInConfig(eachFetchConfigParam, targetType, eachFetch)) {
                                // eslint-disable-next-line
                                eachFetchConfig[eachFetchConfigParam] = eachFetch[eachFetchConfigParam];
                            }
                        }
                        finalConfig[item].push(eachFetchConfig);
                    });
                } else if (item == 'execution_thread') {
                    const value = config[item];
                    if (value !== 'main' && value !== 'worker') {
                        throw new UserError(
                            ErrorCode.BAD_CONFIG,
                            `"${value}" is not a valid value for the property "execution_thread". The only valid values are "main" and "worker"`,
                        );
                    }
                    finalConfig[item] = value;
                } else {
                    // eslint-disable-next-line
                    finalConfig[item] = config[item];
                }
            }
        });
    }

    return fillUserData(config, finalConfig);
}

function validateParamInConfig(paramName: string, paramType: string, config: object): boolean {
    if (paramName in config) {
        return paramType === 'array' ? Array.isArray(config[paramName]) : typeof config[paramName] === paramType;
    }
    return false;
}
