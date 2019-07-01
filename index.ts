function urlGlobToRegex(matchPattern: string): string {
	return '^' + matchPattern
		.replace(/[.]/g, '\\.') // Escape dots
		.replace(/[?]/, '.') // Single-character wildcards
		.replace(/^[*]:/, 'https?') // Protocol
		.replace(/^(https[?]?:[/][/])[*]/, '$1[^/:]+') // Subdomain wildcard
		.replace(/[/][*]/, '/?.+') // Whole path wildcards (so it can match the whole origin)
		.replace(/[*]/g, '.+') // Path wildcards
		.replace(/[/]/g, '\\/'); // Escape slashes
}

// @ts-ignore
async function p<T>(fn, ...args): Promise<T> {
	return new Promise((resolve, reject) => {
		// @ts-ignore
		fn(...args, result => {
			if (chrome.runtime.lastError) {
				reject(chrome.runtime.lastError);
			} else {
				resolve(result);
			}
		});
	});
}

// eslint-disable-next-line no-undef
type _contentScriptsRegister = typeof browser.contentScripts.register;
declare namespace chrome.contentScripts {
	const register: _contentScriptsRegister;
}

async function isOriginPermitted(url: string): Promise<boolean> {
	return p(chrome.permissions.contains, {
		origins: [new URL(url).origin + '/*']
	});
}

async function wasPreviouslyLoaded(tabId: number, loadCheck: string): Promise<boolean> {
	const result = await p<boolean[]>(chrome.tabs.executeScript, tabId, {
		code: loadCheck,
		runAt: 'document_start'
	});

	return result && result[0];
}

if (!chrome.contentScripts) {
	chrome.contentScripts = {
		// The callback is only used by webextension-polyfill
		async register(contentScriptOptions, callback?) {
			const {
				js = [],
				css = [],
				allFrames,
				matchAboutBlank,
				matches,
				runAt
			} = contentScriptOptions;
			// Injectable code; it sets a `true` property on `document` with the hash of the files as key.
			const loadCheck = `document[${JSON.stringify(JSON.stringify({js, css}))}]`;

			const matchesRegex = new RegExp(matches.map(urlGlobToRegex).join('$') + '$');

			const listener = async (tabId: number, {status}: chrome.tabs.TabChangeInfo): Promise<void> => {
				if (status !== 'loading') {
					return;
				}

				const {url} = await p(chrome.tabs.get, tabId);

				if (
					!url || // No URL = no permission;
					!matchesRegex.test(url) || // Manual `matches` glob matching
					!await isOriginPermitted(url) || // Permissions check
					await wasPreviouslyLoaded(tabId, loadCheck) // Double-injection avoidance
				) {
					return;
				}

				for (const file of css) {
					chrome.tabs.insertCSS(tabId, {
						...file,
						matchAboutBlank,
						allFrames,
						runAt: runAt || 'document_start' // CSS should prefer `document_start` when unspecified
					});
				}

				for (const file of js) {
					chrome.tabs.executeScript(tabId, {
						...file,
						matchAboutBlank,
						allFrames,
						runAt
					});
				}

				// Mark as loaded
				chrome.tabs.executeScript(tabId, {
					code: `${loadCheck} = true`,
					runAt: 'document_start',
					allFrames
				});
			};

			chrome.tabs.onUpdated.addListener(listener);
			const registeredContentScript = {
				async unregister() {
					return p(chrome.tabs.onUpdated.removeListener.bind(chrome.tabs.onUpdated), listener);
				}
			};

			if (typeof callback === 'function') {
				callback(registeredContentScript);
			}

			return Promise.resolve(registeredContentScript);
		}
	};
}