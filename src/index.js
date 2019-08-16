// This library is modified by Gumlet.com
// It is copied to node_modules directory in Dockerfile.
// This is a hacky way but is necessary since original library author
// does not accept PRs.

'use strict';

const EventEmitter = require('events');
const urlLib = require('url');
const normalizeUrl = require('normalize-url');
const CachePolicy = require('http-cache-semantics');
const Response = require('responselike');
const lowercaseKeys = require('lowercase-keys');
const cloneResponse = require('clone-response');
const Keyv = require('keyv');

class CacheableRequest {
	constructor(request, cacheAdapter) {
		if (typeof request !== 'function') {
			throw new TypeError('Parameter `request` must be a function');
		}

		this.cache = new Keyv({
			uri: typeof cacheAdapter === 'string' && cacheAdapter,
			store: typeof cacheAdapter !== 'string' && cacheAdapter,
			namespace: 'cacheable-request'
		});

		return this.createCacheableRequest(request);
	}

	createCacheableRequest(request) {
		return (opts, cb) => {
			const ee = new EventEmitter();
			const optsAndURL = prepareOptsAndURL(opts);
			opts = optsAndURL[0];
			const normalizedUrlString = optsAndURL[1];

			const key = `${opts.method}:${normalizedUrlString}`;

			const errorHandler = error => ee.emit('error', new CacheableRequest.CacheError(error));
			this.cache.once('error', errorHandler);
			ee.on('response', () => this.cache.removeListener('error', errorHandler));

			this.getRequest(request, opts, key, ee).then(response => {
				if (response) {
					ee.emit('response', response);
					if (typeof cb === 'function') {
						cb(response);
					}
				}
			}).catch(error => {
				if (error && error.errType === 'cache') {
					ee.emit('error', new CacheableRequest.CacheError(error));
				} else {
					ee.emit('error', new CacheableRequest.RequestError(error));
				}
			});

			return ee;
		};
	}

	async getRequest(request, opts, key, ee) {
		let cacheEntry;
		try {
			cacheEntry = opts.cache ? await this.cache.get(key) : undefined;
		} catch (error) {
			error.errType = 'cache';
			return Promise.reject(error);
		}

		if (typeof cacheEntry === 'undefined') {
			return this.makeRequest(request, opts, ee, key);
		}

		const policy = CachePolicy.fromObject(cacheEntry.cachePolicy);
		if (policy.satisfiesWithoutRevalidation(opts) && !opts.forceRefresh) {
			const headers = policy.responseHeaders();
			const response = new Response(cacheEntry.statusCode, headers, cacheEntry.body, cacheEntry.url);
			response.cachePolicy = policy;
			response.fromCache = true;
			return response;
		} else {
			opts.headers = policy.revalidationHeaders(opts);
			return this.makeRequest(request, opts, ee, key, cacheEntry);
		}
	}

	async makeRequest(request, opts, ee, key, revalidate) {
		// everything must be settled...
		await Promise.resolve();
		const self = this;

		return new Promise((resolve, reject) => {
			const req = request(opts, response => {
				self.handler(response, revalidate, opts, key).then(resolve).catch(reject);
			});
			req.on('error', () =>{});
			req.on('abort', () =>{});
			ee.emit('request', req);
		});
	}

	async handler(response, revalidate, opts, key) {
		// this status setting is required by http-cache-semantics...
		response.status = response.statusCode;
		if (revalidate) {
			const revalidatedPolicy = CachePolicy.fromObject(revalidate.cachePolicy).revalidatedPolicy(opts, response);
			if (!revalidatedPolicy.modified) {
				const headers = revalidatedPolicy.policy.responseHeaders();
				response = new Response(revalidate.statusCode, headers, revalidate.body, revalidate.url);
				response.cachePolicy = revalidatedPolicy.policy;
				response.fromCache = true;
			}
		}

		if (!response.fromCache) {
			response.cachePolicy = new CachePolicy(opts, response, opts);
			response.fromCache = false;
		}

		let clonedResponse;
		if (opts.cache && response.cachePolicy.storable()) {
			clonedResponse = cloneResponse(response);
			this.storeResponse(response, revalidate, opts, key);
		} else if (opts.cache && revalidate) {
			try {
				await this.cache.delete(key);
			} catch (error) {
				error.errType = 'cache';
				return Promise.reject(error);
			}
		}

		return clonedResponse || response;
	}

	async storeResponse(response, revalidate, opts, key) {
		let body = [];
		response.on('data', d => {
			body.push(d);
		});

		let requestAborted = false;
		await Promise.race([
			new Promise((resolve, reject) => response.once('aborted', () => {
				requestAborted = true;
				resolve();
			})),
			new Promise(resolve => response.once('end', () => {
				body = Buffer.concat(body);
				resolve();
			}))
		]);

		if (requestAborted) {
			return;
		}

		const value = {
			cachePolicy: response.cachePolicy.toObject(),
			url: response.url,
			statusCode: response.fromCache ? revalidate.statusCode : response.statusCode,
			body
		};

		let ttl = opts.strictTtl ? response.cachePolicy.timeToLive() : undefined;
		if (opts.maxTtl) {
			ttl = ttl ? Math.min(ttl, opts.maxTtl) : opts.maxTtl;
		}

		let lengthMatches = true;

		if (response.headers && response.headers['content-length']) {
			lengthMatches = parseInt(response.headers['content-length']) == body.byteLength;
		}

		if (Buffer.isBuffer(body) && body.byteLength != 0 && lengthMatches) {
			// Only store non-empty responses...
			await this.cache.set(key, value, ttl);
		}
	}
}

function prepareOptsAndURL(opts) {
	let url;
	if (typeof opts === 'string') {
		url = normalizeUrlObject(urlLib.parse(opts));
		opts = {};
	} else if (opts instanceof urlLib.URL) {
		url = normalizeUrlObject(urlLib.parse(opts.toString()));
		opts = {};
	} else {
		const [pathname, ...searchParts] = (opts.path || '').split('?');
		const search = searchParts.length > 0 ? `?${searchParts.join('?')}` : '';
		url = normalizeUrlObject({ ...opts,
			pathname,
			search
		});
	}
	opts = {
		headers: {},
		method: 'GET',
		cache: true,
		strictTtl: false,
		automaticFailover: false,
		...opts,
		...urlObjectToRequestOptions(url)
	};
	opts.headers = lowercaseKeys(opts.headers);

	const normalizedUrlString = normalizeUrl(urlLib.format(url), {
		stripWWW: false,
		removeTrailingSlash: false,
		stripAuthentication: false
	});
	return [opts, normalizedUrlString];
}

function urlObjectToRequestOptions(url) {
	const options = { ...url
	};
	options.path = `${url.pathname || '/'}${url.search || ''}`;
	delete options.pathname;
	delete options.search;
	return options;
}

function normalizeUrlObject(url) {
	// If url was parsed by url.parse or new URL:
	// - hostname will be set
	// - host will be hostname[:port]
	// - port will be set if it was explicit in the parsed string
	// Otherwise, url was from request options:
	// - hostname or host may be set
	// - host shall not have port encoded
	return {
		protocol: url.protocol,
		auth: url.auth,
		hostname: url.hostname || url.host || 'localhost',
		port: url.port,
		pathname: url.pathname,
		search: url.search
	};
}

CacheableRequest.RequestError = class extends Error {
	constructor(error) {
		super(error.message);
		this.name = 'RequestError';
		Object.assign(this, error);
	}
};

CacheableRequest.CacheError = class extends Error {
	constructor(error) {
		super(error.message);
		this.name = 'CacheError';
		Object.assign(this, error);
	}
};

module.exports = CacheableRequest;
