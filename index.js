'use strict';
const path = require('path');

const escapeStringRegexp = require('escape-string-regexp');
const execa = require('execa');

const pkg = require('./package.json');

const help = 'See https://github.com/avajs/typescript/blob/v${pkg.version}/README.md';

function isPlainObject(x) {
	return x !== null && typeof x === 'object' && Reflect.getPrototypeOf(x) === Object.prototype;
}

function validate(target, properties) {
	const keys = Object.keys(properties);

	for (const key of keys) {
		const {required, isValid} = properties[key];
		const missing = target[key] === undefined;

		if (required && missing) {
			throw new Error(`Missing '${key}' property in TypeScript configuration for AVA. ${help}`);
		} else if (!required && missing) {
			return;
		}

		if (!isValid(target[key])) {
			throw new Error(`Invalid '${key}' property in TypeScript configuration for AVA. ${help}`);
		}
	}
}

function isValidExtensions(extensions) {
	return Array.isArray(extensions) &&
		extensions.length > 0 &&
		extensions.every(ext => typeof ext === 'string' && ext !== '') &&
		new Set(extensions).size === extensions.length;
}

function isValidRewritePaths(rewritePaths) {
	if (!isPlainObject(rewritePaths)) {
		return false;
	}

	return Object.entries(rewritePaths).every(([from, to]) => {
		return from.endsWith('/') && typeof to === 'string' && to.endsWith('/');
	});
}

function isValidCompile(compile) {
	return typeof compile === 'boolean';
}

async function compileTypeScript(projectDir) {
	return execa('tsc', ['--incremental'], {preferLocal: true, cwd: projectDir});
}

const configProperties = {
	compile: {
		required: true,
		isValid: isValidCompile
	},
	rewritePaths: {
		required: true,
		isValid: isValidRewritePaths
	},
	extensions: {
		required: false,
		isValid: isValidExtensions
	}
};

module.exports = ({negotiateProtocol}) => {
	const protocol = negotiateProtocol(['ava-3.2', 'ava-3'], {version: pkg.version});
	if (protocol === null) {
		return;
	}

	return {
		main({config}) {
			if (!isPlainObject(config)) {
				throw new Error(`Unexpected Typescript configuration for AVA. ${help}`);

			}

			validate(config, configProperties);

			const {
				extensions = ['ts'],
				rewritePaths: relativeRewritePaths,
				compile
			} = config;

			const rewritePaths = Object.entries(relativeRewritePaths).map(([from, to]) => [
				path.join(protocol.projectDir, from),
				path.join(protocol.projectDir, to)
			]);
			const testFileExtension = new RegExp(`\\.(${extensions.map(ext => escapeStringRegexp(ext)).join('|')})$`);

			return {
				async compile() {
					if (compile) {
						await compileTypeScript(protocol.projectDir);
					}

					return {
						extensions: extensions.slice(),
						rewritePaths: rewritePaths.slice()
					};
				},

				get extensions() {
					return extensions.slice();
				},

				ignoreChange(filePath) {
					if (!testFileExtension.test(filePath)) {
						return false;
					}

					return rewritePaths.some(([from]) => filePath.startsWith(from));
				},

				resolveTestFile(testfile) {
					if (!testFileExtension.test(testfile)) {
						return testfile;
					}

					const rewrite = rewritePaths.find(([from]) => testfile.startsWith(from));
					if (rewrite === undefined) {
						return testfile;
					}

					const [from, to] = rewrite;
					// TODO: Support JSX preserve mode — https://www.typescriptlang.org/docs/handbook/jsx.html
					return `${to}${testfile.slice(from.length)}`.replace(testFileExtension, '.js');
				},

				updateGlobs({filePatterns, ignoredByWatcherPatterns}) {
					return {
						filePatterns: [
							...filePatterns,
							'!**/*.d.ts',
							...Object.values(relativeRewritePaths).map(to => `!${to}**`)
						],
						ignoredByWatcherPatterns: [
							...ignoredByWatcherPatterns,
							...Object.values(relativeRewritePaths).map(to => `${to}**/*.js.map`)
						]
					};
				}
			};
		},

		worker({extensionsToLoadAsModules, state: {extensions, rewritePaths}}) {
			const testFileExtension = new RegExp(`\\.(${extensions.map(ext => escapeStringRegexp(ext)).join('|')})$`);

			return {
				canLoad(ref) {
					return testFileExtension.test(ref) && rewritePaths.some(([from]) => ref.startsWith(from));
				},

				async load(ref, {requireFn}) {
					for (const extension of extensionsToLoadAsModules) {
						if (ref.endsWith(`.${extension}`)) {
							throw new Error('@ava/typescript cannot yet load ESM files');
						}
					}

					const [from, to] = rewritePaths.find(([from]) => ref.startsWith(from));
					// TODO: Support JSX preserve mode — https://www.typescriptlang.org/docs/handbook/jsx.html
					const rewritten = `${to}${ref.slice(from.length)}`.replace(testFileExtension, '.js');
					return requireFn(rewritten);
				}
			};
		}
	};
};
