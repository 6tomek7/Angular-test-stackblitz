/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { BehaviorSubject, from, Observable, of } from 'rxjs';
import { concatMap, first } from 'rxjs/operators';
import { delayResponse } from './delay-response';
import { getStatusText, isSuccess, STATUS } from './http-status-codes';
import { InMemoryBackendConfig, parseUri, removeTrailingSlash } from './interfaces';
/**
 * Base class for in-memory web api back-ends
 * Simulate the behavior of a RESTy web api
 * backed by the simple in-memory data store provided by the injected `InMemoryDbService` service.
 * Conforms mostly to behavior described here:
 * http://www.restapitutorial.com/lessons/httpmethods.html
 */
export class BackendService {
    constructor(inMemDbService, config = {}) {
        this.inMemDbService = inMemDbService;
        this.config = new InMemoryBackendConfig();
        this.db = {};
        this.requestInfoUtils = this.getRequestInfoUtils();
        const loc = this.getLocation('/');
        this.config.host = loc.host; // default to app web server host
        this.config.rootPath = loc.path; // default to path when app is served (e.g.'/')
        Object.assign(this.config, config);
    }
    get dbReady() {
        if (!this.dbReadySubject) {
            // first time the service is called.
            this.dbReadySubject = new BehaviorSubject(false);
            this.resetDb();
        }
        return this.dbReadySubject.asObservable().pipe(first((r) => r));
    }
    /**
     * Process Request and return an Observable of Http Response object
     * in the manner of a RESTy web api.
     *
     * Expect URI pattern in the form :base/:collectionName/:id?
     * Examples:
     *   // for store with a 'customers' collection
     *   GET api/customers          // all customers
     *   GET api/customers/42       // the character with id=42
     *   GET api/customers?name=^j  // 'j' is a regex; returns customers whose name starts with 'j' or
     * 'J' GET api/customers.json/42  // ignores the ".json"
     *
     * Also accepts direct commands to the service in which the last segment of the apiBase is the
     * word "commands" Examples: POST commands/resetDb, GET/POST commands/config - get or (re)set the
     * config
     *
     *   HTTP overrides:
     *     If the injected inMemDbService defines an HTTP method (lowercase)
     *     The request is forwarded to that method as in
     *     `inMemDbService.get(requestInfo)`
     *     which must return either an Observable of the response type
     *     for this http library or null|undefined (which means "keep processing").
     */
    handleRequest(req) {
        //  handle the request when there is an in-memory database
        return this.dbReady.pipe(concatMap(() => this.handleRequest_(req)));
    }
    handleRequest_(req) {
        const url = req.urlWithParams ? req.urlWithParams : req.url;
        // Try override parser
        // If no override parser or it returns nothing, use default parser
        const parser = this.bind('parseRequestUrl');
        const parsed = (parser && parser(url, this.requestInfoUtils)) || this.parseRequestUrl(url);
        const collectionName = parsed.collectionName;
        const collection = this.db[collectionName];
        const reqInfo = {
            req: req,
            apiBase: parsed.apiBase,
            collection: collection,
            collectionName: collectionName,
            headers: this.createHeaders({ 'Content-Type': 'application/json' }),
            id: this.parseId(collection, collectionName, parsed.id),
            method: this.getRequestMethod(req),
            query: parsed.query,
            resourceUrl: parsed.resourceUrl,
            url: url,
            utils: this.requestInfoUtils
        };
        let resOptions;
        if (/commands\/?$/i.test(reqInfo.apiBase)) {
            return this.commands(reqInfo);
        }
        const methodInterceptor = this.bind(reqInfo.method);
        if (methodInterceptor) {
            // InMemoryDbService intercepts this HTTP method.
            // if interceptor produced a response, return it.
            // else InMemoryDbService chose not to intercept; continue processing.
            const interceptorResponse = methodInterceptor(reqInfo);
            if (interceptorResponse) {
                return interceptorResponse;
            }
        }
        if (this.db[collectionName]) {
            // request is for a known collection of the InMemoryDbService
            return this.createResponse$(() => this.collectionHandler(reqInfo));
        }
        if (this.config.passThruUnknownUrl) {
            // unknown collection; pass request thru to a "real" backend.
            return this.getPassThruBackend().handle(req);
        }
        // 404 - can't handle this request
        resOptions = this.createErrorResponseOptions(url, STATUS.NOT_FOUND, `Collection '${collectionName}' not found`);
        return this.createResponse$(() => resOptions);
    }
    /**
     * Add configured delay to response observable unless delay === 0
     */
    addDelay(response) {
        const d = this.config.delay;
        return d === 0 ? response : delayResponse(response, d || 500);
    }
    /**
     * Apply query/search parameters as a filter over the collection
     * This impl only supports RegExp queries on string properties of the collection
     * ANDs the conditions together
     */
    applyQuery(collection, query) {
        // extract filtering conditions - {propertyName, RegExps) - from query/search parameters
        const conditions = [];
        const caseSensitive = this.config.caseSensitiveSearch ? undefined : 'i';
        query.forEach((value, name) => {
            value.forEach(v => conditions.push({ name, rx: new RegExp(decodeURI(v), caseSensitive) }));
        });
        const len = conditions.length;
        if (!len) {
            return collection;
        }
        // AND the RegExp conditions
        return collection.filter(row => {
            let ok = true;
            let i = len;
            while (ok && i) {
                i -= 1;
                const cond = conditions[i];
                ok = cond.rx.test(row[cond.name]);
            }
            return ok;
        });
    }
    /**
     * Get a method from the `InMemoryDbService` (if it exists), bound to that service
     */
    bind(methodName) {
        const fn = this.inMemDbService[methodName];
        return fn ? fn.bind(this.inMemDbService) : undefined;
    }
    bodify(data) {
        return this.config.dataEncapsulation ? { data } : data;
    }
    clone(data) {
        return JSON.parse(JSON.stringify(data));
    }
    collectionHandler(reqInfo) {
        // const req = reqInfo.req;
        let resOptions;
        switch (reqInfo.method) {
            case 'get':
                resOptions = this.get(reqInfo);
                break;
            case 'post':
                resOptions = this.post(reqInfo);
                break;
            case 'put':
                resOptions = this.put(reqInfo);
                break;
            case 'delete':
                resOptions = this.delete(reqInfo);
                break;
            default:
                resOptions = this.createErrorResponseOptions(reqInfo.url, STATUS.METHOD_NOT_ALLOWED, 'Method not allowed');
                break;
        }
        // If `inMemDbService.responseInterceptor` exists, let it morph the response options
        const interceptor = this.bind('responseInterceptor');
        return interceptor ? interceptor(resOptions, reqInfo) : resOptions;
    }
    /**
     * Commands reconfigure the in-memory web api service or extract information from it.
     * Commands ignore the latency delay and respond ASAP.
     *
     * When the last segment of the `apiBase` path is "commands",
     * the `collectionName` is the command.
     *
     * Example URLs:
     *   commands/resetdb (POST) // Reset the "database" to its original state
     *   commands/config (GET)   // Return this service's config object
     *   commands/config (POST)  // Update the config (e.g. the delay)
     *
     * Usage:
     *   http.post('commands/resetdb', undefined);
     *   http.get('commands/config');
     *   http.post('commands/config', '{"delay":1000}');
     */
    commands(reqInfo) {
        const command = reqInfo.collectionName.toLowerCase();
        const method = reqInfo.method;
        let resOptions = { url: reqInfo.url };
        switch (command) {
            case 'resetdb':
                resOptions.status = STATUS.NO_CONTENT;
                return this.resetDb(reqInfo).pipe(concatMap(() => this.createResponse$(() => resOptions, false /* no latency delay */)));
            case 'config':
                if (method === 'get') {
                    resOptions.status = STATUS.OK;
                    resOptions.body = this.clone(this.config);
                    // any other HTTP method is assumed to be a config update
                }
                else {
                    const body = this.getJsonBody(reqInfo.req);
                    Object.assign(this.config, body);
                    this.passThruBackend = undefined; // re-create when needed
                    resOptions.status = STATUS.NO_CONTENT;
                }
                break;
            default:
                resOptions = this.createErrorResponseOptions(reqInfo.url, STATUS.INTERNAL_SERVER_ERROR, `Unknown command "${command}"`);
        }
        return this.createResponse$(() => resOptions, false /* no latency delay */);
    }
    createErrorResponseOptions(url, status, message) {
        return {
            body: { error: `${message}` },
            url: url,
            headers: this.createHeaders({ 'Content-Type': 'application/json' }),
            status: status
        };
    }
    /**
     * Create a cold response Observable from a factory for ResponseOptions
     * @param resOptionsFactory - creates ResponseOptions when observable is subscribed
     * @param withDelay - if true (default), add simulated latency delay from configuration
     */
    createResponse$(resOptionsFactory, withDelay = true) {
        const resOptions$ = this.createResponseOptions$(resOptionsFactory);
        let resp$ = this.createResponse$fromResponseOptions$(resOptions$);
        return withDelay ? this.addDelay(resp$) : resp$;
    }
    /**
     * Create a cold Observable of ResponseOptions.
     * @param resOptionsFactory - creates ResponseOptions when observable is subscribed
     */
    createResponseOptions$(resOptionsFactory) {
        return new Observable((responseObserver) => {
            let resOptions;
            try {
                resOptions = resOptionsFactory();
            }
            catch (error) {
                const err = error.message || error;
                resOptions = this.createErrorResponseOptions('', STATUS.INTERNAL_SERVER_ERROR, `${err}`);
            }
            const status = resOptions.status;
            try {
                resOptions.statusText = status != null ? getStatusText(status) : undefined;
            }
            catch (e) { /* ignore failure */
            }
            if (status != null && isSuccess(status)) {
                responseObserver.next(resOptions);
                responseObserver.complete();
            }
            else {
                responseObserver.error(resOptions);
            }
            return () => { }; // unsubscribe function
        });
    }
    delete({ collection, collectionName, headers, id, url }) {
        if (id == null) {
            return this.createErrorResponseOptions(url, STATUS.NOT_FOUND, `Missing "${collectionName}" id`);
        }
        const exists = this.removeById(collection, id);
        return {
            headers: headers,
            status: (exists || !this.config.delete404) ? STATUS.NO_CONTENT : STATUS.NOT_FOUND
        };
    }
    /**
     * Find first instance of item in collection by `item.id`
     * @param collection
     * @param id
     */
    findById(collection, id) {
        return collection.find((item) => item.id === id);
    }
    /**
     * Generate the next available id for item in this collection
     * Use method from `inMemDbService` if it exists and returns a value,
     * else delegates to `genIdDefault`.
     * @param collection - collection of items with `id` key property
     */
    genId(collection, collectionName) {
        const genId = this.bind('genId');
        if (genId) {
            const id = genId(collection, collectionName);
            if (id != null) {
                return id;
            }
        }
        return this.genIdDefault(collection, collectionName);
    }
    /**
     * Default generator of the next available id for item in this collection
     * This default implementation works only for numeric ids.
     * @param collection - collection of items with `id` key property
     * @param collectionName - name of the collection
     */
    genIdDefault(collection, collectionName) {
        if (!this.isCollectionIdNumeric(collection, collectionName)) {
            throw new Error(`Collection '${collectionName}' id type is non-numeric or unknown. Can only generate numeric ids.`);
        }
        let maxId = 0;
        collection.reduce((prev, item) => {
            maxId = Math.max(maxId, typeof item.id === 'number' ? item.id : maxId);
        }, undefined);
        return maxId + 1;
    }
    get({ collection, collectionName, headers, id, query, url }) {
        let data = collection;
        if (id != null && id !== '') {
            data = this.findById(collection, id);
        }
        else if (query) {
            data = this.applyQuery(collection, query);
        }
        if (!data) {
            return this.createErrorResponseOptions(url, STATUS.NOT_FOUND, `'${collectionName}' with id='${id}' not found`);
        }
        return { body: this.bodify(this.clone(data)), headers: headers, status: STATUS.OK };
    }
    /**
     * Get location info from a url, even on server where `document` is not defined
     */
    getLocation(url) {
        if (!url.startsWith('http')) {
            // get the document iff running in browser
            const doc = (typeof document === 'undefined') ? undefined : document;
            // add host info to url before parsing.  Use a fake host when not in browser.
            const base = doc ? doc.location.protocol + '//' + doc.location.host : 'http://fake';
            url = url.startsWith('/') ? base + url : base + '/' + url;
        }
        return parseUri(url);
    }
    /**
     * get or create the function that passes unhandled requests
     * through to the "real" backend.
     */
    getPassThruBackend() {
        return this.passThruBackend ? this.passThruBackend :
            this.passThruBackend = this.createPassThruBackend();
    }
    /**
     * Get utility methods from this service instance.
     * Useful within an HTTP method override
     */
    getRequestInfoUtils() {
        return {
            createResponse$: this.createResponse$.bind(this),
            findById: this.findById.bind(this),
            isCollectionIdNumeric: this.isCollectionIdNumeric.bind(this),
            getConfig: () => this.config,
            getDb: () => this.db,
            getJsonBody: this.getJsonBody.bind(this),
            getLocation: this.getLocation.bind(this),
            getPassThruBackend: this.getPassThruBackend.bind(this),
            parseRequestUrl: this.parseRequestUrl.bind(this),
        };
    }
    indexOf(collection, id) {
        return collection.findIndex((item) => item.id === id);
    }
    /** Parse the id as a number. Return original value if not a number. */
    parseId(collection, collectionName, id) {
        if (!this.isCollectionIdNumeric(collection, collectionName)) {
            // Can't confirm that `id` is a numeric type; don't parse as a number
            // or else `'42'` -> `42` and _get by id_ fails.
            return id;
        }
        const idNum = parseFloat(id);
        return isNaN(idNum) ? id : idNum;
    }
    /**
     * return true if can determine that the collection's `item.id` is a number
     * This implementation can't tell if the collection is empty so it assumes NO
     * */
    isCollectionIdNumeric(collection, collectionName) {
        // collectionName not used now but override might maintain collection type information
        // so that it could know the type of the `id` even when the collection is empty.
        return !!(collection && collection[0]) && typeof collection[0].id === 'number';
    }
    /**
     * Parses the request URL into a `ParsedRequestUrl` object.
     * Parsing depends upon certain values of `config`: `apiBase`, `host`, and `urlRoot`.
     *
     * Configuring the `apiBase` yields the most interesting changes to `parseRequestUrl` behavior:
     *   When apiBase=undefined and url='http://localhost/api/collection/42'
     *     {base: 'api/', collectionName: 'collection', id: '42', ...}
     *   When apiBase='some/api/root/' and url='http://localhost/some/api/root/collection'
     *     {base: 'some/api/root/', collectionName: 'collection', id: undefined, ...}
     *   When apiBase='/' and url='http://localhost/collection'
     *     {base: '/', collectionName: 'collection', id: undefined, ...}
     *
     * The actual api base segment values are ignored. Only the number of segments matters.
     * The following api base strings are considered identical: 'a/b' ~ 'some/api/' ~ `two/segments'
     *
     * To replace this default method, assign your alternative to your
     * InMemDbService['parseRequestUrl']
     */
    parseRequestUrl(url) {
        try {
            const loc = this.getLocation(url);
            let drop = (this.config.rootPath || '').length;
            let urlRoot = '';
            if (loc.host !== this.config.host) {
                // url for a server on a different host!
                // assume it's collection is actually here too.
                drop = 1; // the leading slash
                urlRoot = loc.protocol + '//' + loc.host + '/';
            }
            const path = loc.path.substring(drop);
            const pathSegments = path.split('/');
            let segmentIndex = 0;
            // apiBase: the front part of the path devoted to getting to the api route
            // Assumes first path segment if no config.apiBase
            // else ignores as many path segments as are in config.apiBase
            // Does NOT care what the api base chars actually are.
            let apiBase;
            if (this.config.apiBase == null) {
                apiBase = pathSegments[segmentIndex++];
            }
            else {
                apiBase = removeTrailingSlash(this.config.apiBase.trim());
                if (apiBase) {
                    segmentIndex = apiBase.split('/').length;
                }
                else {
                    segmentIndex = 0; // no api base at all; unwise but allowed.
                }
            }
            apiBase += '/';
            let collectionName = pathSegments[segmentIndex++];
            // ignore anything after a '.' (e.g.,the "json" in "customers.json")
            collectionName = collectionName && collectionName.split('.')[0];
            const id = pathSegments[segmentIndex++];
            const query = this.createQueryMap(loc.query);
            const resourceUrl = urlRoot + apiBase + collectionName + '/';
            return { apiBase, collectionName, id, query, resourceUrl };
        }
        catch (err) {
            const msg = `unable to parse url '${url}'; original error: ${err.message}`;
            throw new Error(msg);
        }
    }
    // Create entity
    // Can update an existing entity too if post409 is false.
    post({ collection, collectionName, headers, id, req, resourceUrl, url }) {
        const item = this.clone(this.getJsonBody(req));
        if (item.id == null) {
            try {
                item.id = id || this.genId(collection, collectionName);
            }
            catch (err) {
                const emsg = err.message || '';
                if (/id type is non-numeric/.test(emsg)) {
                    return this.createErrorResponseOptions(url, STATUS.UNPROCESSABLE_ENTRY, emsg);
                }
                else {
                    return this.createErrorResponseOptions(url, STATUS.INTERNAL_SERVER_ERROR, `Failed to generate new id for '${collectionName}'`);
                }
            }
        }
        if (id && id !== item.id) {
            return this.createErrorResponseOptions(url, STATUS.BAD_REQUEST, `Request id does not match item.id`);
        }
        else {
            id = item.id;
        }
        const existingIx = this.indexOf(collection, id);
        const body = this.bodify(item);
        if (existingIx === -1) {
            collection.push(item);
            headers.set('Location', resourceUrl + '/' + id);
            return { headers, body, status: STATUS.CREATED };
        }
        else if (this.config.post409) {
            return this.createErrorResponseOptions(url, STATUS.CONFLICT, `'${collectionName}' item with id='${id} exists and may not be updated with POST; use PUT instead.`);
        }
        else {
            collection[existingIx] = item;
            return this.config.post204 ? { headers, status: STATUS.NO_CONTENT } : // successful; no content
                { headers, body, status: STATUS.OK }; // successful; return entity
        }
    }
    // Update existing entity
    // Can create an entity too if put404 is false.
    put({ collection, collectionName, headers, id, req, url }) {
        const item = this.clone(this.getJsonBody(req));
        if (item.id == null) {
            return this.createErrorResponseOptions(url, STATUS.NOT_FOUND, `Missing '${collectionName}' id`);
        }
        if (id && id !== item.id) {
            return this.createErrorResponseOptions(url, STATUS.BAD_REQUEST, `Request for '${collectionName}' id does not match item.id`);
        }
        else {
            id = item.id;
        }
        const existingIx = this.indexOf(collection, id);
        const body = this.bodify(item);
        if (existingIx > -1) {
            collection[existingIx] = item;
            return this.config.put204 ? { headers, status: STATUS.NO_CONTENT } : // successful; no content
                { headers, body, status: STATUS.OK }; // successful; return entity
        }
        else if (this.config.put404) {
            // item to update not found; use POST to create new item for this id.
            return this.createErrorResponseOptions(url, STATUS.NOT_FOUND, `'${collectionName}' item with id='${id} not found and may not be created with PUT; use POST instead.`);
        }
        else {
            // create new item for id not found
            collection.push(item);
            return { headers, body, status: STATUS.CREATED };
        }
    }
    removeById(collection, id) {
        const ix = this.indexOf(collection, id);
        if (ix > -1) {
            collection.splice(ix, 1);
            return true;
        }
        return false;
    }
    /**
     * Tell your in-mem "database" to reset.
     * returns Observable of the database because resetting it could be async
     */
    resetDb(reqInfo) {
        this.dbReadySubject && this.dbReadySubject.next(false);
        const db = this.inMemDbService.createDb(reqInfo);
        const db$ = db instanceof Observable ?
            db :
            typeof db.then === 'function' ? from(db) : of(db);
        db$.pipe(first()).subscribe((d) => {
            this.db = d;
            this.dbReadySubject && this.dbReadySubject.next(true);
        });
        return this.dbReady;
    }
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiYmFja2VuZC1zZXJ2aWNlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWlzYy9hbmd1bGFyLWluLW1lbW9yeS13ZWItYXBpL3NyYy9iYWNrZW5kLXNlcnZpY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7OztHQU1HO0FBR0gsT0FBTyxFQUFDLGVBQWUsRUFBRSxJQUFJLEVBQUUsVUFBVSxFQUFZLEVBQUUsRUFBQyxNQUFNLE1BQU0sQ0FBQztBQUNyRSxPQUFPLEVBQUMsU0FBUyxFQUFFLEtBQUssRUFBQyxNQUFNLGdCQUFnQixDQUFDO0FBRWhELE9BQU8sRUFBQyxhQUFhLEVBQUMsTUFBTSxrQkFBa0IsQ0FBQztBQUMvQyxPQUFPLEVBQUMsYUFBYSxFQUFFLFNBQVMsRUFBRSxNQUFNLEVBQUMsTUFBTSxxQkFBcUIsQ0FBQztBQUNyRSxPQUFPLEVBQUMscUJBQXFCLEVBQWtFLFFBQVEsRUFBbUIsbUJBQW1CLEVBQTJFLE1BQU0sY0FBYyxDQUFDO0FBRTdPOzs7Ozs7R0FNRztBQUNILE1BQU0sT0FBZ0IsY0FBYztJQU9sQyxZQUFzQixjQUFpQyxFQUFFLFNBQW9DLEVBQUU7UUFBekUsbUJBQWMsR0FBZCxjQUFjLENBQW1CO1FBTjdDLFdBQU0sR0FBOEIsSUFBSSxxQkFBcUIsRUFBRSxDQUFDO1FBQ2hFLE9BQUUsR0FBeUIsRUFBRSxDQUFDO1FBRzlCLHFCQUFnQixHQUFHLElBQUksQ0FBQyxtQkFBbUIsRUFBRSxDQUFDO1FBR3RELE1BQU0sR0FBRyxHQUFHLElBQUksQ0FBQyxXQUFXLENBQUMsR0FBRyxDQUFDLENBQUM7UUFDbEMsSUFBSSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEdBQUcsR0FBRyxDQUFDLElBQUksQ0FBQyxDQUFNLGlDQUFpQztRQUNuRSxJQUFJLENBQUMsTUFBTSxDQUFDLFFBQVEsR0FBRyxHQUFHLENBQUMsSUFBSSxDQUFDLENBQUUsK0NBQStDO1FBQ2pGLE1B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QUMsQ0FBQztRQUN2RCxNQUFNLEVBQUUsR0FBRyxJQUFJLENBQUMsY0FBYyxDQUFDLFFBQVEsQ0FBQyxPQUFPLENBQUMsQ0FBQztRQUNqRCxNQUFNLEdBQUcsR0FBRyxFQUFFLFlBQVksVUFBVSxDQUFDLENBQUM7WUFDbEMsRUFBRSxDQUFDLENBQUM7WUFDSixPQUFRLEVBQVUsQ0FBQyxJQUFJLEtBQUssVUFBVSxDQUFDLENBQUMsQ0FBQyxJQUFJLENBQUMsRUFBa0IsQ0FBQyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsRUFBRSxDQUFDLENBQUM7UUFDL0UsR0FBRyxDQUFDLElBQUksQ0FBQyxLQUFLLEVBQUUsQ0FBQyxDQUFDLFNBQVMsQ0FBQyxDQUFDLENBQUssRUFBRSxFQUFFO1lBQ3BDLElBQUksQ0FBQyxFQUFFLEdBQUcsQ0FBQyxDQUFDO1lBQ1osSUFBSSxDQUFDLGNBQWMsSUFBSSxJQUFJLENBQUMsY0FBYyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsQ0FBQztRQUN4RCxDQUFDLENBQUMsQ0FBQztRQUNILE9BQU8sSUFBSSxDQUFDLE9BQU8sQ0FBQztJQUN0QixDQUFDO0NBQ0YiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIExMQyBBbGwgUmlnaHRzIFJlc2VydmVkLlxuICpcbiAqIFVzZSBvZiB0aGlzIHNvdXJjZSBjb2RlIGlzIGdvdmVybmVkIGJ5IGFuIE1JVC1zdHlsZSBsaWNlbnNlIHRoYXQgY2FuIGJlXG4gKiBmb3VuZCBpbiB0aGUgTElDRU5TRSBmaWxlIGF0IGh0dHBzOi8vYW5ndWxhci5pby9saWNlbnNlXG4gKi9cblxuaW1wb3J0IHtIdHRwSGVhZGVyc30gZnJvbSAnQGFuZ3VsYXIvY29tbW9uL2h0dHAnO1xuaW1wb3J0IHtCZWhhdmlvclN1YmplY3QsIGZyb20sIE9ic2VydmFibGUsIE9ic2VydmVyLCBvZn0gZnJvbSAncnhqcyc7XG5pbXBvcnQge2NvbmNhdE1hcCwgZmlyc3R9IGZyb20gJ3J4anMvb3BlcmF0b3JzJztcblxuaW1wb3J0IHtkZWxheVJlc3BvbnNlfSBmcm9tICcuL2RlbGF5LXJlc3BvbnNlJztcbmltcG9ydCB7Z2V0U3RhdHVzVGV4dCwgaXNTdWNjZXNzLCBTVEFUVVN9IGZyb20gJy4vaHR0cC1zdGF0dXMtY29kZXMnO1xuaW1wb3J0IHtJbk1lbW9yeUJhY2tlbmRDb25maWcsIEluTWVtb3J5QmFja2VuZENvbmZpZ0FyZ3MsIEluTWVtb3J5RGJTZXJ2aWNlLCBQYXJzZWRSZXF1ZXN0VXJsLCBwYXJzZVVyaSwgUGFzc1RocnVCYWNrZW5kLCByZW1vdmVUcmFpbGluZ1NsYXNoLCBSZXF1ZXN0Q29yZSwgUmVxdWVzdEluZm8sIFJlcXVlc3RJbmZvVXRpbGl0aWVzLCBSZXNwb25zZU9wdGlvbnMsIFVyaUluZm99IGZyb20gJy4vaW50ZXJmYWNlcyc7XG5cbi8qKlxuICogQmFzZSBjbGFzcyBmb3IgaW4tbWVtb3J5IHdlYiBhcGkgYmFjay1lbmRzXG4gKiBTaW11bGF0ZSB0aGUgYmVoYXZpb3Igb2YgYSBSRVNUeSB3ZWIgYXBpXG4gKiBiYWNrZWQgYnkgdGhlIHNpbXBsZSBpbi1tZW1vcnkgZGF0YSBzdG9yZSBwcm92aWRlZCBieSB0aGUgaW5qZWN0ZWQgYEluTWVtb3J5RGJTZXJ2aWNlYCBzZXJ2aWNlLlxuICogQ29uZm9ybXMgbW9zdGx5IHRvIGJlaGF2aW9yIGRlc2NyaWJlZCBoZXJlOlxuICogaHR0cDovL3d3dy5yZXN0YXBpdHV0b3JpYWwuY29tL2xlc3NvbnMvaHR0cG1ldGhvZHMuaHRtbFxuICovXG5leHBvcnQgYWJzdHJhY3QgY2xhc3MgQmFja2VuZFNlcnZpY2Uge1xuICBwcm90ZWN0ZWQgY29uZmlnOiBJbk1lbW9yeUJhY2tlbmRDb25maWdBcmdzID0gbmV3IEluTWVtb3J5QmFja2VuZENvbmZpZygpO1xuICBwcm90ZWN0ZWQgZGI6IHtba2V5OiBzdHJpbmddOiBhbnl9ID0ge307XG4gIHByb3RlY3RlZCBkYlJlYWR5U3ViamVjdDogQmVoYXZpb3JTdWJqZWN0PGJvb2xlYW4+fHVuZGVmaW5lZDtcbiAgcHJpdmF0ZSBwYXNzVGhydUJhY2tlbmQ6IFBhc3NUaHJ1QmFja2VuZHx1bmRlZmluZWQ7XG4gIHByb3RlY3RlZCByZXF1ZXN0SW5mb1V0aWxzID0gdGhpcy5nZXRSZXF1ZXN0SW5mb1V0aWxzKCk7XG5cbiAgY29uc3RydWN0b3IocHJvdGVjdGVkIGluTWVtRGJTZXJ2aWNlOiBJbk1lbW9yeURiU2VydmljZSwgY29uZmlnOiBJbk1lbW9yeUJhY2tlbmRDb25maWdBcmdzID0ge30pIHtcbiAgICBjb25zdCBsb2MgPSB0aGlzLmdldExvY2F0aW9uKCcvJyk7XG4gICAgdGhpcy5jb25maWcuaG9zdCA9IGxvYy5ob3N0OyAgICAgIC8vIGRlZmF1bHQgdG8gYXBwIHdlYiBzZXJ2ZXIgaG9zdFxuICAgIHRoaXMuY29uZmlnLnJvb3RQYXRoID0gbG9jLnBhdGg7ICAvLyBkZWZhdWx0IHRvIHBhdGggd2hlbiBhcHAgaXMgc2VydmVkIChlLmcuJy8nKVxuICAgIE9iamVjdC5hc3NpZ24odGhpcy5jb25maWcsIGNvbmZpZyk7XG4gIH1cblxuICBwcm90ZWN0ZWQgZ2V0IGRiUmVhZHkoKTogT2JzZXJ2YWJsZTxib29sZWFuPiB7XG4gICAgaWYgKCF0aGlzLmRiUmVhZHlTdWJqZWN0KSB7XG4gICAgICAvLyBmaXJzdCB0aW1lIHRoZSBzZXJ2aWNlIGlzIGNhbGxlZC5cbiAgICAgIHRoaXMuZGJSZWFkeVN1YmplY3QgPSBuZXcgQmVoYXZpb3JTdWJqZWN0PGJvb2xlYW4+KGZhbHNlKTtcbiAgICAgIHRoaXMucmVzZXREYigpO1xuICAgIH1cbiAgICByZXR1cm4gdGhpcy5kYlJlYWR5U3ViamVjdC5hc09ic2VydmFibGUoKS5waXBlKGZpcnN0KChyOiBib29sZWFuKSA9PiByKSk7XG4gIH1cblxuICAvKipcbiAgICogUHJvY2VzcyBSZXF1ZXN0IGFuZCByZXR1cm4gYW4gT2JzZXJ2YWJsZSBvZiBIdHRwIFJlc3BvbnNlIG9iamVjdFxuICAgKiBpbiB0aGUgbWFubmVyIG9mIGEgUkVTVHkgd2ViIGFwaS5cbiAgICpcbiAgICogRXhwZWN0IFVSSSBwYXR0ZXJuIGluIHRoZSBmb3JtIDpiYXNlLzpjb2xsZWN0aW9uTmFtZS86aWQ/XG4gICAqIEV4YW1wbGVzOlxuICAgKiAgIC8vIGZvciBzdG9yZSB3aXRoIGEgJ2N1c3RvbWVycycgY29sbGVjdGlvblxuICAgKiAgIEdFVCBhcGkvY3VzdG9tZXJzICAgICAgICAgIC8vIGFsbCBjdXN0b21lcnNcbiAgICogICBHRVQgYXBpL2N1c3RvbWVycy80MiAgICAgICAvLyB0aGUgY2hhcmFjdGVyIHdpdGggaWQ9NDJcbiAgICogICBHRVQgYXBpL2N1c3RvbWVycz9uYW1lPV5qICAvLyAnaicgaXMgYSByZWdleDsgcmV0dXJucyBjdXN0b21lcnMgd2hvc2UgbmFtZSBzdGFydHMgd2l0aCAnaicgb3JcbiAgICogJ0onIEdFVCBhcGkvY3VzdG9tZXJzLmpzb24vNDIgIC8vIGlnbm9yZXMgdGhlIFwiLmpzb25cIlxuICAgKlxuICAgKiBBbHNvIGFjY2VwdHMgZGlyZWN0IGNvbW1hbmRzIHRvIHRoZSBzZXJ2aWNlIGluIHdoaWNoIHRoZSBsYXN0IHNlZ21lbnQgb2YgdGhlIGFwaUJhc2UgaXMgdGhlXG4gICAqIHdvcmQgXCJjb21tYW5kc1wiIEV4YW1wbGVzOiBQT1NUIGNvbW1hbmRzL3Jlc2V0RGIsIEdFVC9QT1NUIGNvbW1hbmRzL2NvbmZpZyAtIGdldCBvciAocmUpc2V0IHRoZVxuICAgKiBjb25maWdcbiAgICpcbiAgICogICBIVFRQIG92ZXJyaWRlczpcbiAgICogICAgIElmIHRoZSBpbmplY3RlZCBpbk1lbURiU2VydmljZSBkZWZpbmVzIGFuIEhUVFAgbWV0aG9kIChsb3dlcmNhc2UpXG4gICAqICAgICBUaGUgcmVxdWVzdCBpcyBmb3J3YXJkZWQgdG8gdGhhdCBtZXRob2QgYXMgaW5cbiAgICogICAgIGBpbk1lbURiU2VydmljZS5nZXQocmVxdWVzdEluZm8pYFxuICAgKiAgICAgd2hpY2ggbXVzdCByZXR1cm4gZWl0aGVyIGFuIE9ic2VydmFibGUgb2YgdGhlIHJlc3BvbnNlIHR5cGVcbiAgICogICAgIGZvciB0aGlzIGh0dHAgbGlicmFyeSBvciBudWxsfHVuZGVmaW5lZCAod2hpY2ggbWVhbnMgXCJrZWVwIHByb2Nlc3NpbmdcIikuXG4gICAqL1xuICBwcm90ZWN0ZWQgaGFuZGxlUmVxdWVzdChyZXE6IFJlcXVlc3RDb3JlKTogT2JzZXJ2YWJsZTxhbnk+IHtcbiAgICAvLyAgaGFuZGxlIHRoZSByZXF1ZXN0IHdoZW4gdGhlcmUgaXMgYW4gaW4tbWVtb3J5IGRhdGFiYXNlXG4gICAgcmV0dXJuIHRoaXMuZGJSZWFkeS5waXBlKGNvbmNhdE1hcCgoKSA9PiB0aGlzLmhhbmRsZVJlcXVlc3RfKHJlcSkpKTtcbiAgfVxuXG4gIHByb3RlY3RlZCBoYW5kbGVSZXF1ZXN0XyhyZXE6IFJlcXVlc3RDb3JlKTogT2JzZXJ2YWJsZTxhbnk+IHtcbiAgICBjb25zdCB1cmwgPSByZXEudXJsV2l0aFBhcmFtcyA/IHJlcS51cmxXaXRoUGFyYW1zIDogcmVxLnVybDtcblxuICAgIC8vIFRyeSBvdmVycmlkZSBwYXJzZXJcbiAgICAvLyBJZiBubyBvdmVycmlkZSBwYXJzZXIgb3IgaXQgcmV0dXJucyBub3RoaW5nLCB1c2UgZGVmYXVsdCBwYXJzZXJcbiAgICBjb25zdCBwYXJzZXIgPSB0aGlzLmJpbmQoJ3BhcnNlUmVxdWVzdFVybCcpO1xuICAgIGNvbnN0IHBhcnNlZDogUGFyc2VkUmVxdWVzdFVybCA9XG4gICAgICAgIChwYXJzZXIgJiYgcGFyc2VyKHVybCwgdGhpcy5yZXF1ZXN0SW5mb1V0aWxzKSkgfHwgdGhpcy5wYXJzZVJlcXVlc3RVcmwodXJsKTtcblxuICAgIGNvbnN0IGNvbGxlY3Rpb25OYW1lID0gcGFyc2VkLmNvbGxlY3Rpb25OYW1lO1xuICAgIGNvbnN0IGNvbGxlY3Rpb24gPSB0aGlzLmRiW2NvbGxlY3Rpb25OYW1lXTtcblxuICAgIGNvbnN0IHJlcUluZm86IFJlcXVlc3RJbmZvID0ge1xuICAgICAgcmVxOiByZXEsXG4gICAgICBhcGlCYXNlOiBwYXJzZWQuYXBpQmFzZSxcbiAgICAgIGNvbGxlY3Rpb246IGNvbGxlY3Rpb24sXG4gICAgICBjb2xsZWN0aW9uTmFtZTogY29sbGVjdGlvbk5hbWUsXG4gICAgICBoZWFkZXJzOiB0aGlzLmNyZWF0ZUhlYWRlcnMoeydDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbid9KSxcbiAgICAgIGlkOiB0aGlzLnBhcnNlSWQoY29sbGVjdGlvbiwgY29sbGVjdGlvbk5hbWUsIHBhcnNlZC5pZCksXG4gICAgICBtZXRob2Q6IHRoaXMuZ2V0UmVxdWVzdE1ldGhvZChyZXEpLFxuICAgICAgcXVlcnk6IHBhcnNlZC5xdWVyeSxcbiAgICAgIHJlc291cmNlVXJsOiBwYXJzZWQucmVzb3VyY2VVcmwsXG4gICAgICB1cmw6IHVybCxcbiAgICAgIHV0aWxzOiB0aGlzLnJlcXVlc3RJbmZvVXRpbHNcbiAgICB9O1xuXG4gICAgbGV0IHJlc09wdGlvbnM6IFJlc3BvbnNlT3B0aW9ucztcblxuICAgIGlmICgvY29tbWFuZHNcXC8/JC9pLnRlc3QocmVxSW5mby5hcGlCYXNlKSkge1xuICAgICAgcmV0dXJuIHRoaXMuY29tbWFuZHMocmVxSW5mbyk7XG4gICAgfVxuXG4gICAgY29uc3QgbWV0aG9kSW50ZXJjZXB0b3IgPSB0aGlzLmJpbmQocmVxSW5mby5tZXRob2QpO1xuICAgIGlmIChtZXRob2RJbnRlcmNlcHRvcikge1xuICAgICAgLy8gSW5NZW1vcnlEYlNlcnZpY2UgaW50ZXJjZXB0cyB0aGlzIEhUVFAgbWV0aG9kLlxuICAgICAgLy8gaWYgaW50ZXJjZXB0b3IgcHJvZHVjZWQgYSByZXNwb25zZSwgcmV0dXJuIGl0LlxuICAgICAgLy8gZWxzZSBJbk1lbW9yeURiU2VydmljZSBjaG9zZSBub3QgdG8gaW50ZXJjZXB0OyBjb250aW51ZSBwcm9jZXNzaW5nLlxuICAgICAgY29uc3QgaW50ZXJjZXB0b3JSZXNwb25zZSA9IG1ldGhvZEludGVyY2VwdG9yKHJlcUluZm8pO1xuICAgICAgaWYgKGludGVyY2VwdG9yUmVzcG9uc2UpIHtcbiAgICAgICAgcmV0dXJuIGludGVyY2VwdG9yUmVzcG9uc2U7XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuZGJbY29sbGVjdGlvbk5hbWVdKSB7XG4gICAgICAvLyByZXF1ZXN0IGlzIGZvciBhIGtub3duIGNvbGxlY3Rpb24gb2YgdGhlIEluTWVtb3J5RGJTZXJ2aWNlXG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVSZXNwb25zZSQoKCkgPT4gdGhpcy5jb2xsZWN0aW9uSGFuZGxlcihyZXFJbmZvKSk7XG4gICAgfVxuXG4gICAgaWYgKHRoaXMuY29uZmlnLnBhc3NUaHJ1VW5rbm93blVybCkge1xuICAgICAgLy8gdW5rbm93biBjb2xsZWN0aW9uOyBwYXNzIHJlcXVlc3QgdGhydSB0byBhIFwicmVhbFwiIGJhY2tlbmQuXG4gICAgICByZXR1cm4gdGhpcy5nZXRQYXNzVGhydUJhY2tlbmQoKS5oYW5kbGUocmVxKTtcbiAgICB9XG5cbiAgICAvLyA0MDQgLSBjYW4ndCBoYW5kbGUgdGhpcyByZXF1ZXN0XG4gICAgcmVzT3B0aW9ucyA9IHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgIHVybCwgU1RBVFVTLk5PVF9GT1VORCwgYENvbGxlY3Rpb24gJyR7Y29sbGVjdGlvbk5hbWV9JyBub3QgZm91bmRgKTtcbiAgICByZXR1cm4gdGhpcy5jcmVhdGVSZXNwb25zZSQoKCkgPT4gcmVzT3B0aW9ucyk7XG4gIH1cblxuICAvKipcbiAgICogQWRkIGNvbmZpZ3VyZWQgZGVsYXkgdG8gcmVzcG9uc2Ugb2JzZXJ2YWJsZSB1bmxlc3MgZGVsYXkgPT09IDBcbiAgICovXG4gIHByb3RlY3RlZCBhZGREZWxheShyZXNwb25zZTogT2JzZXJ2YWJsZTxhbnk+KTogT2JzZXJ2YWJsZTxhbnk+IHtcbiAgICBjb25zdCBkID0gdGhpcy5jb25maWcuZGVsYXk7XG4gICAgcmV0dXJuIGQgPT09IDAgPyByZXNwb25zZSA6IGRlbGF5UmVzcG9uc2UocmVzcG9uc2UsIGQgfHwgNTAwKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBBcHBseSBxdWVyeS9zZWFyY2ggcGFyYW1ldGVycyBhcyBhIGZpbHRlciBvdmVyIHRoZSBjb2xsZWN0aW9uXG4gICAqIFRoaXMgaW1wbCBvbmx5IHN1cHBvcnRzIFJlZ0V4cCBxdWVyaWVzIG9uIHN0cmluZyBwcm9wZXJ0aWVzIG9mIHRoZSBjb2xsZWN0aW9uXG4gICAqIEFORHMgdGhlIGNvbmRpdGlvbnMgdG9nZXRoZXJcbiAgICovXG4gIHByb3RlY3RlZCBhcHBseVF1ZXJ5KGNvbGxlY3Rpb246IGFueVtdLCBxdWVyeTogTWFwPHN0cmluZywgc3RyaW5nW10+KTogYW55W10ge1xuICAgIC8vIGV4dHJhY3QgZmlsdGVyaW5nIGNvbmRpdGlvbnMgLSB7cHJvcGVydHlOYW1lLCBSZWdFeHBzKSAtIGZyb20gcXVlcnkvc2VhcmNoIHBhcmFtZXRlcnNcbiAgICBjb25zdCBjb25kaXRpb25zOiB7bmFtZTogc3RyaW5nLCByeDogUmVnRXhwfVtdID0gW107XG4gICAgY29uc3QgY2FzZVNlbnNpdGl2ZSA9IHRoaXMuY29uZmlnLmNhc2VTZW5zaXRpdmVTZWFyY2ggPyB1bmRlZmluZWQgOiAnaSc7XG4gICAgcXVlcnkuZm9yRWFjaCgodmFsdWU6IHN0cmluZ1tdLCBuYW1lOiBzdHJpbmcpID0+IHtcbiAgICAgIHZhbHVlLmZvckVhY2godiA9PiBjb25kaXRpb25zLnB1c2goe25hbWUsIHJ4OiBuZXcgUmVnRXhwKGRlY29kZVVSSSh2KSwgY2FzZVNlbnNpdGl2ZSl9KSk7XG4gICAgfSk7XG5cbiAgICBjb25zdCBsZW4gPSBjb25kaXRpb25zLmxlbmd0aDtcbiAgICBpZiAoIWxlbikge1xuICAgICAgcmV0dXJuIGNvbGxlY3Rpb247XG4gICAgfVxuXG4gICAgLy8gQU5EIHRoZSBSZWdFeHAgY29uZGl0aW9uc1xuICAgIHJldHVybiBjb2xsZWN0aW9uLmZpbHRlcihyb3cgPT4ge1xuICAgICAgbGV0IG9rID0gdHJ1ZTtcbiAgICAgIGxldCBpID0gbGVuO1xuICAgICAgd2hpbGUgKG9rICYmIGkpIHtcbiAgICAgICAgaSAtPSAxO1xuICAgICAgICBjb25zdCBjb25kID0gY29uZGl0aW9uc1tpXTtcbiAgICAgICAgb2sgPSBjb25kLnJ4LnRlc3Qocm93W2NvbmQubmFtZV0pO1xuICAgICAgfVxuICAgICAgcmV0dXJuIG9rO1xuICAgIH0pO1xuICB9XG5cbiAgLyoqXG4gICAqIEdldCBhIG1ldGhvZCBmcm9tIHRoZSBgSW5NZW1vcnlEYlNlcnZpY2VgIChpZiBpdCBleGlzdHMpLCBib3VuZCB0byB0aGF0IHNlcnZpY2VcbiAgICovXG4gIHByb3RlY3RlZCBiaW5kPFQgZXh0ZW5kcyBGdW5jdGlvbj4obWV0aG9kTmFtZTogc3RyaW5nKSB7XG4gICAgY29uc3QgZm4gPSAodGhpcy5pbk1lbURiU2VydmljZSBhcyBhbnkpW21ldGhvZE5hbWVdO1xuICAgIHJldHVybiBmbiA/IGZuLmJpbmQodGhpcy5pbk1lbURiU2VydmljZSkgYXMgVCA6IHVuZGVmaW5lZDtcbiAgfVxuXG4gIHByb3RlY3RlZCBib2RpZnkoZGF0YTogYW55KSB7XG4gICAgcmV0dXJuIHRoaXMuY29uZmlnLmRhdGFFbmNhcHN1bGF0aW9uID8ge2RhdGF9IDogZGF0YTtcbiAgfVxuXG4gIHByb3RlY3RlZCBjbG9uZShkYXRhOiBhbnkpIHtcbiAgICByZXR1cm4gSlNPTi5wYXJzZShKU09OLnN0cmluZ2lmeShkYXRhKSk7XG4gIH1cblxuICBwcm90ZWN0ZWQgY29sbGVjdGlvbkhhbmRsZXIocmVxSW5mbzogUmVxdWVzdEluZm8pOiBSZXNwb25zZU9wdGlvbnMge1xuICAgIC8vIGNvbnN0IHJlcSA9IHJlcUluZm8ucmVxO1xuICAgIGxldCByZXNPcHRpb25zOiBSZXNwb25zZU9wdGlvbnM7XG4gICAgc3dpdGNoIChyZXFJbmZvLm1ldGhvZCkge1xuICAgICAgY2FzZSAnZ2V0JzpcbiAgICAgICAgcmVzT3B0aW9ucyA9IHRoaXMuZ2V0KHJlcUluZm8pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ3Bvc3QnOlxuICAgICAgICByZXNPcHRpb25zID0gdGhpcy5wb3N0KHJlcUluZm8pO1xuICAgICAgICBicmVhaztcbiAgICAgIGNhc2UgJ3B1dCc6XG4gICAgICAgIHJlc09wdGlvbnMgPSB0aGlzLnB1dChyZXFJbmZvKTtcbiAgICAgICAgYnJlYWs7XG4gICAgICBjYXNlICdkZWxldGUnOlxuICAgICAgICByZXNPcHRpb25zID0gdGhpcy5kZWxldGUocmVxSW5mbyk7XG4gICAgICAgIGJyZWFrO1xuICAgICAgZGVmYXVsdDpcbiAgICAgICAgcmVzT3B0aW9ucyA9IHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgICByZXFJbmZvLnVybCwgU1RBVFVTLk1FVEhPRF9OT1RfQUxMT1dFRCwgJ01ldGhvZCBub3QgYWxsb3dlZCcpO1xuICAgICAgICBicmVhaztcbiAgICB9XG5cbiAgICAvLyBJZiBgaW5NZW1EYlNlcnZpY2UucmVzcG9uc2VJbnRlcmNlcHRvcmAgZXhpc3RzLCBsZXQgaXQgbW9ycGggdGhlIHJlc3BvbnNlIG9wdGlvbnNcbiAgICBjb25zdCBpbnRlcmNlcHRvciA9IHRoaXMuYmluZCgncmVzcG9uc2VJbnRlcmNlcHRvcicpO1xuICAgIHJldHVybiBpbnRlcmNlcHRvciA/IGludGVyY2VwdG9yKHJlc09wdGlvbnMsIHJlcUluZm8pIDogcmVzT3B0aW9ucztcbiAgfVxuXG4gIC8qKlxuICAgKiBDb21tYW5kcyByZWNvbmZpZ3VyZSB0aGUgaW4tbWVtb3J5IHdlYiBhcGkgc2VydmljZSBvciBleHRyYWN0IGluZm9ybWF0aW9uIGZyb20gaXQuXG4gICAqIENvbW1hbmRzIGlnbm9yZSB0aGUgbGF0ZW5jeSBkZWxheSBhbmQgcmVzcG9uZCBBU0FQLlxuICAgKlxuICAgKiBXaGVuIHRoZSBsYXN0IHNlZ21lbnQgb2YgdGhlIGBhcGlCYXNlYCBwYXRoIGlzIFwiY29tbWFuZHNcIixcbiAgICogdGhlIGBjb2xsZWN0aW9uTmFtZWAgaXMgdGhlIGNvbW1hbmQuXG4gICAqXG4gICAqIEV4YW1wbGUgVVJMczpcbiAgICogICBjb21tYW5kcy9yZXNldGRiIChQT1NUKSAvLyBSZXNldCB0aGUgXCJkYXRhYmFzZVwiIHRvIGl0cyBvcmlnaW5hbCBzdGF0ZVxuICAgKiAgIGNvbW1hbmRzL2NvbmZpZyAoR0VUKSAgIC8vIFJldHVybiB0aGlzIHNlcnZpY2UncyBjb25maWcgb2JqZWN0XG4gICAqICAgY29tbWFuZHMvY29uZmlnIChQT1NUKSAgLy8gVXBkYXRlIHRoZSBjb25maWcgKGUuZy4gdGhlIGRlbGF5KVxuICAgKlxuICAgKiBVc2FnZTpcbiAgICogICBodHRwLnBvc3QoJ2NvbW1hbmRzL3Jlc2V0ZGInLCB1bmRlZmluZWQpO1xuICAgKiAgIGh0dHAuZ2V0KCdjb21tYW5kcy9jb25maWcnKTtcbiAgICogICBodHRwLnBvc3QoJ2NvbW1hbmRzL2NvbmZpZycsICd7XCJkZWxheVwiOjEwMDB9Jyk7XG4gICAqL1xuICBwcm90ZWN0ZWQgY29tbWFuZHMocmVxSW5mbzogUmVxdWVzdEluZm8pOiBPYnNlcnZhYmxlPGFueT4ge1xuICAgIGNvbnN0IGNvbW1hbmQgPSByZXFJbmZvLmNvbGxlY3Rpb25OYW1lLnRvTG93ZXJDYXNlKCk7XG4gICAgY29uc3QgbWV0aG9kID0gcmVxSW5mby5tZXRob2Q7XG5cbiAgICBsZXQgcmVzT3B0aW9uczogUmVzcG9uc2VPcHRpb25zID0ge3VybDogcmVxSW5mby51cmx9O1xuXG4gICAgc3dpdGNoIChjb21tYW5kKSB7XG4gICAgICBjYXNlICdyZXNldGRiJzpcbiAgICAgICAgcmVzT3B0aW9ucy5zdGF0dXMgPSBTVEFUVVMuTk9fQ09OVEVOVDtcbiAgICAgICAgcmV0dXJuIHRoaXMucmVzZXREYihyZXFJbmZvKS5waXBlKFxuICAgICAgICAgICAgY29uY2F0TWFwKCgpID0+IHRoaXMuY3JlYXRlUmVzcG9uc2UkKCgpID0+IHJlc09wdGlvbnMsIGZhbHNlIC8qIG5vIGxhdGVuY3kgZGVsYXkgKi8pKSk7XG5cbiAgICAgIGNhc2UgJ2NvbmZpZyc6XG4gICAgICAgIGlmIChtZXRob2QgPT09ICdnZXQnKSB7XG4gICAgICAgICAgcmVzT3B0aW9ucy5zdGF0dXMgPSBTVEFUVVMuT0s7XG4gICAgICAgICAgcmVzT3B0aW9ucy5ib2R5ID0gdGhpcy5jbG9uZSh0aGlzLmNvbmZpZyk7XG5cbiAgICAgICAgICAvLyBhbnkgb3RoZXIgSFRUUCBtZXRob2QgaXMgYXNzdW1lZCB0byBiZSBhIGNvbmZpZyB1cGRhdGVcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICBjb25zdCBib2R5ID0gdGhpcy5nZXRKc29uQm9keShyZXFJbmZvLnJlcSk7XG4gICAgICAgICAgT2JqZWN0LmFzc2lnbih0aGlzLmNvbmZpZywgYm9keSk7XG4gICAgICAgICAgdGhpcy5wYXNzVGhydUJhY2tlbmQgPSB1bmRlZmluZWQ7ICAvLyByZS1jcmVhdGUgd2hlbiBuZWVkZWRcblxuICAgICAgICAgIHJlc09wdGlvbnMuc3RhdHVzID0gU1RBVFVTLk5PX0NPTlRFTlQ7XG4gICAgICAgIH1cbiAgICAgICAgYnJlYWs7XG5cbiAgICAgIGRlZmF1bHQ6XG4gICAgICAgIHJlc09wdGlvbnMgPSB0aGlzLmNyZWF0ZUVycm9yUmVzcG9uc2VPcHRpb25zKFxuICAgICAgICAgICAgcmVxSW5mby51cmwsIFNUQVRVUy5JTlRFUk5BTF9TRVJWRVJfRVJST1IsIGBVbmtub3duIGNvbW1hbmQgXCIke2NvbW1hbmR9XCJgKTtcbiAgICB9XG5cbiAgICByZXR1cm4gdGhpcy5jcmVhdGVSZXNwb25zZSQoKCkgPT4gcmVzT3B0aW9ucywgZmFsc2UgLyogbm8gbGF0ZW5jeSBkZWxheSAqLyk7XG4gIH1cblxuICBwcm90ZWN0ZWQgY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnModXJsOiBzdHJpbmcsIHN0YXR1czogbnVtYmVyLCBtZXNzYWdlOiBzdHJpbmcpOlxuICAgICAgUmVzcG9uc2VPcHRpb25zIHtcbiAgICByZXR1cm4ge1xuICAgICAgYm9keToge2Vycm9yOiBgJHttZXNzYWdlfWB9LFxuICAgICAgdXJsOiB1cmwsXG4gICAgICBoZWFkZXJzOiB0aGlzLmNyZWF0ZUhlYWRlcnMoeydDb250ZW50LVR5cGUnOiAnYXBwbGljYXRpb24vanNvbid9KSxcbiAgICAgIHN0YXR1czogc3RhdHVzXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGUgc3RhbmRhcmQgSFRUUCBoZWFkZXJzIG9iamVjdCBmcm9tIGhhc2ggbWFwIG9mIGhlYWRlciBzdHJpbmdzXG4gICAqIEBwYXJhbSBoZWFkZXJzXG4gICAqL1xuICBwcm90ZWN0ZWQgYWJzdHJhY3QgY3JlYXRlSGVhZGVycyhoZWFkZXJzOiB7W2luZGV4OiBzdHJpbmddOiBzdHJpbmd9KTogSHR0cEhlYWRlcnM7XG5cbiAgLyoqXG4gICAqIGNyZWF0ZSB0aGUgZnVuY3Rpb24gdGhhdCBwYXNzZXMgdW5oYW5kbGVkIHJlcXVlc3RzIHRocm91Z2ggdG8gdGhlIFwicmVhbFwiIGJhY2tlbmQuXG4gICAqL1xuICBwcm90ZWN0ZWQgYWJzdHJhY3QgY3JlYXRlUGFzc1RocnVCYWNrZW5kKCk6IFBhc3NUaHJ1QmFja2VuZDtcblxuICAvKipcbiAgICogcmV0dXJuIGEgc2VhcmNoIG1hcCBmcm9tIGEgbG9jYXRpb24gcXVlcnkvc2VhcmNoIHN0cmluZ1xuICAgKi9cbiAgcHJvdGVjdGVkIGFic3RyYWN0IGNyZWF0ZVF1ZXJ5TWFwKHNlYXJjaDogc3RyaW5nKTogTWFwPHN0cmluZywgc3RyaW5nW10+O1xuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBjb2xkIHJlc3BvbnNlIE9ic2VydmFibGUgZnJvbSBhIGZhY3RvcnkgZm9yIFJlc3BvbnNlT3B0aW9uc1xuICAgKiBAcGFyYW0gcmVzT3B0aW9uc0ZhY3RvcnkgLSBjcmVhdGVzIFJlc3BvbnNlT3B0aW9ucyB3aGVuIG9ic2VydmFibGUgaXMgc3Vic2NyaWJlZFxuICAgKiBAcGFyYW0gd2l0aERlbGF5IC0gaWYgdHJ1ZSAoZGVmYXVsdCksIGFkZCBzaW11bGF0ZWQgbGF0ZW5jeSBkZWxheSBmcm9tIGNvbmZpZ3VyYXRpb25cbiAgICovXG4gIHByb3RlY3RlZCBjcmVhdGVSZXNwb25zZSQocmVzT3B0aW9uc0ZhY3Rvcnk6ICgpID0+IFJlc3BvbnNlT3B0aW9ucywgd2l0aERlbGF5ID0gdHJ1ZSk6XG4gICAgICBPYnNlcnZhYmxlPGFueT4ge1xuICAgIGNvbnN0IHJlc09wdGlvbnMkID0gdGhpcy5jcmVhdGVSZXNwb25zZU9wdGlvbnMkKHJlc09wdGlvbnNGYWN0b3J5KTtcbiAgICBsZXQgcmVzcCQgPSB0aGlzLmNyZWF0ZVJlc3BvbnNlJGZyb21SZXNwb25zZU9wdGlvbnMkKHJlc09wdGlvbnMkKTtcbiAgICByZXR1cm4gd2l0aERlbGF5ID8gdGhpcy5hZGREZWxheShyZXNwJCkgOiByZXNwJDtcbiAgfVxuXG4gIC8qKlxuICAgKiBDcmVhdGUgYSBSZXNwb25zZSBvYnNlcnZhYmxlIGZyb20gUmVzcG9uc2VPcHRpb25zIG9ic2VydmFibGUuXG4gICAqL1xuICBwcm90ZWN0ZWQgYWJzdHJhY3QgY3JlYXRlUmVzcG9uc2UkZnJvbVJlc3BvbnNlT3B0aW9ucyQocmVzT3B0aW9ucyQ6IE9ic2VydmFibGU8UmVzcG9uc2VPcHRpb25zPik6XG4gICAgICBPYnNlcnZhYmxlPGFueT47XG5cbiAgLyoqXG4gICAqIENyZWF0ZSBhIGNvbGQgT2JzZXJ2YWJsZSBvZiBSZXNwb25zZU9wdGlvbnMuXG4gICAqIEBwYXJhbSByZXNPcHRpb25zRmFjdG9yeSAtIGNyZWF0ZXMgUmVzcG9uc2VPcHRpb25zIHdoZW4gb2JzZXJ2YWJsZSBpcyBzdWJzY3JpYmVkXG4gICAqL1xuICBwcm90ZWN0ZWQgY3JlYXRlUmVzcG9uc2VPcHRpb25zJChyZXNPcHRpb25zRmFjdG9yeTogKCkgPT4gUmVzcG9uc2VPcHRpb25zKTpcbiAgICAgIE9ic2VydmFibGU8UmVzcG9uc2VPcHRpb25zPiB7XG4gICAgcmV0dXJuIG5ldyBPYnNlcnZhYmxlPFJlc3BvbnNlT3B0aW9ucz4oKHJlc3BvbnNlT2JzZXJ2ZXI6IE9ic2VydmVyPFJlc3BvbnNlT3B0aW9ucz4pID0+IHtcbiAgICAgIGxldCByZXNPcHRpb25zOiBSZXNwb25zZU9wdGlvbnM7XG4gICAgICB0cnkge1xuICAgICAgICByZXNPcHRpb25zID0gcmVzT3B0aW9uc0ZhY3RvcnkoKTtcbiAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XG4gICAgICAgIGNvbnN0IGVyciA9IGVycm9yLm1lc3NhZ2UgfHwgZXJyb3I7XG4gICAgICAgIHJlc09wdGlvbnMgPSB0aGlzLmNyZWF0ZUVycm9yUmVzcG9uc2VPcHRpb25zKCcnLCBTVEFUVVMuSU5URVJOQUxfU0VSVkVSX0VSUk9SLCBgJHtlcnJ9YCk7XG4gICAgICB9XG5cbiAgICAgIGNvbnN0IHN0YXR1cyA9IHJlc09wdGlvbnMuc3RhdHVzO1xuICAgICAgdHJ5IHtcbiAgICAgICAgcmVzT3B0aW9ucy5zdGF0dXNUZXh0ID0gc3RhdHVzICE9IG51bGwgPyBnZXRTdGF0dXNUZXh0KHN0YXR1cykgOiB1bmRlZmluZWQ7XG4gICAgICB9IGNhdGNoIChlKSB7IC8qIGlnbm9yZSBmYWlsdXJlICovXG4gICAgICB9XG4gICAgICBpZiAoc3RhdHVzICE9IG51bGwgJiYgaXNTdWNjZXNzKHN0YXR1cykpIHtcbiAgICAgICAgcmVzcG9uc2VPYnNlcnZlci5uZXh0KHJlc09wdGlvbnMpO1xuICAgICAgICByZXNwb25zZU9ic2VydmVyLmNvbXBsZXRlKCk7XG4gICAgICB9IGVsc2Uge1xuICAgICAgICByZXNwb25zZU9ic2VydmVyLmVycm9yKHJlc09wdGlvbnMpO1xuICAgICAgfVxuICAgICAgcmV0dXJuICgpID0+IHt9OyAgLy8gdW5zdWJzY3JpYmUgZnVuY3Rpb25cbiAgICB9KTtcbiAgfVxuXG4gIHByb3RlY3RlZCBkZWxldGUoe2NvbGxlY3Rpb24sIGNvbGxlY3Rpb25OYW1lLCBoZWFkZXJzLCBpZCwgdXJsfTogUmVxdWVzdEluZm8pOiBSZXNwb25zZU9wdGlvbnMge1xuICAgIGlmIChpZCA9PSBudWxsKSB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVFcnJvclJlc3BvbnNlT3B0aW9ucyhcbiAgICAgICAgICB1cmwsIFNUQVRVUy5OT1RfRk9VTkQsIGBNaXNzaW5nIFwiJHtjb2xsZWN0aW9uTmFtZX1cIiBpZGApO1xuICAgIH1cbiAgICBjb25zdCBleGlzdHMgPSB0aGlzLnJlbW92ZUJ5SWQoY29sbGVjdGlvbiwgaWQpO1xuICAgIHJldHVybiB7XG4gICAgICBoZWFkZXJzOiBoZWFkZXJzLFxuICAgICAgc3RhdHVzOiAoZXhpc3RzIHx8ICF0aGlzLmNvbmZpZy5kZWxldGU0MDQpID8gU1RBVFVTLk5PX0NPTlRFTlQgOiBTVEFUVVMuTk9UX0ZPVU5EXG4gICAgfTtcbiAgfVxuXG4gIC8qKlxuICAgKiBGaW5kIGZpcnN0IGluc3RhbmNlIG9mIGl0ZW0gaW4gY29sbGVjdGlvbiBieSBgaXRlbS5pZGBcbiAgICogQHBhcmFtIGNvbGxlY3Rpb25cbiAgICogQHBhcmFtIGlkXG4gICAqL1xuICBwcm90ZWN0ZWQgZmluZEJ5SWQ8VCBleHRlbmRzIHtpZDogYW55fT4oY29sbGVjdGlvbjogVFtdLCBpZDogYW55KTogVHx1bmRlZmluZWQge1xuICAgIHJldHVybiBjb2xsZWN0aW9uLmZpbmQoKGl0ZW06IFQpID0+IGl0ZW0uaWQgPT09IGlkKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBHZW5lcmF0ZSB0aGUgbmV4dCBhdmFpbGFibGUgaWQgZm9yIGl0ZW0gaW4gdGhpcyBjb2xsZWN0aW9uXG4gICAqIFVzZSBtZXRob2QgZnJvbSBgaW5NZW1EYlNlcnZpY2VgIGlmIGl0IGV4aXN0cyBhbmQgcmV0dXJucyBhIHZhbHVlLFxuICAgKiBlbHNlIGRlbGVnYXRlcyB0byBgZ2VuSWREZWZhdWx0YC5cbiAgICogQHBhcmFtIGNvbGxlY3Rpb24gLSBjb2xsZWN0aW9uIG9mIGl0ZW1zIHdpdGggYGlkYCBrZXkgcHJvcGVydHlcbiAgICovXG4gIHByb3RlY3RlZCBnZW5JZDxUIGV4dGVuZHMge2lkOiBhbnl9Pihjb2xsZWN0aW9uOiBUW10sIGNvbGxlY3Rpb25OYW1lOiBzdHJpbmcpOiBhbnkge1xuICAgIGNvbnN0IGdlbklkID0gdGhpcy5iaW5kKCdnZW5JZCcpO1xuICAgIGlmIChnZW5JZCkge1xuICAgICAgY29uc3QgaWQgPSBnZW5JZChjb2xsZWN0aW9uLCBjb2xsZWN0aW9uTmFtZSk7XG4gICAgICBpZiAoaWQgIT0gbnVsbCkge1xuICAgICAgICByZXR1cm4gaWQ7XG4gICAgICB9XG4gICAgfVxuICAgIHJldHVybiB0aGlzLmdlbklkRGVmYXVsdChjb2xsZWN0aW9uLCBjb2xsZWN0aW9uTmFtZSk7XG4gIH1cblxuICAvKipcbiAgICogRGVmYXVsdCBnZW5lcmF0b3Igb2YgdGhlIG5leHQgYXZhaWxhYmxlIGlkIGZvciBpdGVtIGluIHRoaXMgY29sbGVjdGlvblxuICAgKiBUaGlzIGRlZmF1bHQgaW1wbGVtZW50YXRpb24gd29ya3Mgb25seSBmb3IgbnVtZXJpYyBpZHMuXG4gICAqIEBwYXJhbSBjb2xsZWN0aW9uIC0gY29sbGVjdGlvbiBvZiBpdGVtcyB3aXRoIGBpZGAga2V5IHByb3BlcnR5XG4gICAqIEBwYXJhbSBjb2xsZWN0aW9uTmFtZSAtIG5hbWUgb2YgdGhlIGNvbGxlY3Rpb25cbiAgICovXG4gIHByb3RlY3RlZCBnZW5JZERlZmF1bHQ8VCBleHRlbmRzIHtpZDogYW55fT4oY29sbGVjdGlvbjogVFtdLCBjb2xsZWN0aW9uTmFtZTogc3RyaW5nKTogYW55IHtcbiAgICBpZiAoIXRoaXMuaXNDb2xsZWN0aW9uSWROdW1lcmljKGNvbGxlY3Rpb24sIGNvbGxlY3Rpb25OYW1lKSkge1xuICAgICAgdGhyb3cgbmV3IEVycm9yKGBDb2xsZWN0aW9uICcke1xuICAgICAgICAgIGNvbGxlY3Rpb25OYW1lfScgaWQgdHlwZSBpcyBub24tbnVtZXJpYyBvciB1bmtub3duLiBDYW4gb25seSBnZW5lcmF0ZSBudW1lcmljIGlkcy5gKTtcbiAgICB9XG5cbiAgICBsZXQgbWF4SWQgPSAwO1xuICAgIGNvbGxlY3Rpb24ucmVkdWNlKChwcmV2OiBhbnksIGl0ZW06IGFueSkgPT4ge1xuICAgICAgbWF4SWQgPSBNYXRoLm1heChtYXhJZCwgdHlwZW9mIGl0ZW0uaWQgPT09ICdudW1iZXInID8gaXRlbS5pZCA6IG1heElkKTtcbiAgICB9LCB1bmRlZmluZWQpO1xuICAgIHJldHVybiBtYXhJZCArIDE7XG4gIH1cblxuICBwcm90ZWN0ZWQgZ2V0KHtjb2xsZWN0aW9uLCBjb2xsZWN0aW9uTmFtZSwgaGVhZGVycywgaWQsIHF1ZXJ5LCB1cmx9OiBSZXF1ZXN0SW5mbyk6XG4gICAgICBSZXNwb25zZU9wdGlvbnMge1xuICAgIGxldCBkYXRhID0gY29sbGVjdGlvbjtcblxuICAgIGlmIChpZCAhPSBudWxsICYmIGlkICE9PSAnJykge1xuICAgICAgZGF0YSA9IHRoaXMuZmluZEJ5SWQoY29sbGVjdGlvbiwgaWQpO1xuICAgIH0gZWxzZSBpZiAocXVlcnkpIHtcbiAgICAgIGRhdGEgPSB0aGlzLmFwcGx5UXVlcnkoY29sbGVjdGlvbiwgcXVlcnkpO1xuICAgIH1cblxuICAgIGlmICghZGF0YSkge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgdXJsLCBTVEFUVVMuTk9UX0ZPVU5ELCBgJyR7Y29sbGVjdGlvbk5hbWV9JyB3aXRoIGlkPScke2lkfScgbm90IGZvdW5kYCk7XG4gICAgfVxuICAgIHJldHVybiB7Ym9keTogdGhpcy5ib2RpZnkodGhpcy5jbG9uZShkYXRhKSksIGhlYWRlcnM6IGhlYWRlcnMsIHN0YXR1czogU1RBVFVTLk9LfTtcbiAgfVxuXG4gIC8qKiBHZXQgSlNPTiBib2R5IGZyb20gdGhlIHJlcXVlc3Qgb2JqZWN0ICovXG4gIHByb3RlY3RlZCBhYnN0cmFjdCBnZXRKc29uQm9keShyZXE6IGFueSk6IGFueTtcblxuICAvKipcbiAgICogR2V0IGxvY2F0aW9uIGluZm8gZnJvbSBhIHVybCwgZXZlbiBvbiBzZXJ2ZXIgd2hlcmUgYGRvY3VtZW50YCBpcyBub3QgZGVmaW5lZFxuICAgKi9cbiAgcHJvdGVjdGVkIGdldExvY2F0aW9uKHVybDogc3RyaW5nKTogVXJpSW5mbyB7XG4gICAgaWYgKCF1cmwuc3RhcnRzV2l0aCgnaHR0cCcpKSB7XG4gICAgICAvLyBnZXQgdGhlIGRvY3VtZW50IGlmZiBydW5uaW5nIGluIGJyb3dzZXJcbiAgICAgIGNvbnN0IGRvYyA9ICh0eXBlb2YgZG9jdW1lbnQgPT09ICd1bmRlZmluZWQnKSA/IHVuZGVmaW5lZCA6IGRvY3VtZW50O1xuICAgICAgLy8gYWRkIGhvc3QgaW5mbyB0byB1cmwgYmVmb3JlIHBhcnNpbmcuICBVc2UgYSBmYWtlIGhvc3Qgd2hlbiBub3QgaW4gYnJvd3Nlci5cbiAgICAgIGNvbnN0IGJhc2UgPSBkb2MgPyBkb2MubG9jYXRpb24ucHJvdG9jb2wgKyAnLy8nICsgZG9jLmxvY2F0aW9uLmhvc3QgOiAnaHR0cDovL2Zha2UnO1xuICAgICAgdXJsID0gdXJsLnN0YXJ0c1dpdGgoJy8nKSA/IGJhc2UgKyB1cmwgOiBiYXNlICsgJy8nICsgdXJsO1xuICAgIH1cbiAgICByZXR1cm4gcGFyc2VVcmkodXJsKTtcbiAgfVxuXG4gIC8qKlxuICAgKiBnZXQgb3IgY3JlYXRlIHRoZSBmdW5jdGlvbiB0aGF0IHBhc3NlcyB1bmhhbmRsZWQgcmVxdWVzdHNcbiAgICogdGhyb3VnaCB0byB0aGUgXCJyZWFsXCIgYmFja2VuZC5cbiAgICovXG4gIHByb3RlY3RlZCBnZXRQYXNzVGhydUJhY2tlbmQoKTogUGFzc1RocnVCYWNrZW5kIHtcbiAgICByZXR1cm4gdGhpcy5wYXNzVGhydUJhY2tlbmQgPyB0aGlzLnBhc3NUaHJ1QmFja2VuZCA6XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhpcy5wYXNzVGhydUJhY2tlbmQgPSB0aGlzLmNyZWF0ZVBhc3NUaHJ1QmFja2VuZCgpO1xuICB9XG5cbiAgLyoqXG4gICAqIEdldCB1dGlsaXR5IG1ldGhvZHMgZnJvbSB0aGlzIHNlcnZpY2UgaW5zdGFuY2UuXG4gICAqIFVzZWZ1bCB3aXRoaW4gYW4gSFRUUCBtZXRob2Qgb3ZlcnJpZGVcbiAgICovXG4gIHByb3RlY3RlZCBnZXRSZXF1ZXN0SW5mb1V0aWxzKCk6IFJlcXVlc3RJbmZvVXRpbGl0aWVzIHtcbiAgICByZXR1cm4ge1xuICAgICAgY3JlYXRlUmVzcG9uc2UkOiB0aGlzLmNyZWF0ZVJlc3BvbnNlJC5iaW5kKHRoaXMpLFxuICAgICAgZmluZEJ5SWQ6IHRoaXMuZmluZEJ5SWQuYmluZCh0aGlzKSxcbiAgICAgIGlzQ29sbGVjdGlvbklkTnVtZXJpYzogdGhpcy5pc0NvbGxlY3Rpb25JZE51bWVyaWMuYmluZCh0aGlzKSxcbiAgICAgIGdldENvbmZpZzogKCkgPT4gdGhpcy5jb25maWcsXG4gICAgICBnZXREYjogKCkgPT4gdGhpcy5kYixcbiAgICAgIGdldEpzb25Cb2R5OiB0aGlzLmdldEpzb25Cb2R5LmJpbmQodGhpcyksXG4gICAgICBnZXRMb2NhdGlvbjogdGhpcy5nZXRMb2NhdGlvbi5iaW5kKHRoaXMpLFxuICAgICAgZ2V0UGFzc1RocnVCYWNrZW5kOiB0aGlzLmdldFBhc3NUaHJ1QmFja2VuZC5iaW5kKHRoaXMpLFxuICAgICAgcGFyc2VSZXF1ZXN0VXJsOiB0aGlzLnBhcnNlUmVxdWVzdFVybC5iaW5kKHRoaXMpLFxuICAgIH07XG4gIH1cblxuICAvKipcbiAgICogcmV0dXJuIGNhbm9uaWNhbCBIVFRQIG1ldGhvZCBuYW1lIChsb3dlcmNhc2UpIGZyb20gdGhlIHJlcXVlc3Qgb2JqZWN0XG4gICAqIGUuZy4gKHJlcS5tZXRob2QgfHwgJ2dldCcpLnRvTG93ZXJDYXNlKCk7XG4gICAqIEBwYXJhbSByZXEgLSByZXF1ZXN0IG9iamVjdCBmcm9tIHRoZSBodHRwIGNhbGxcbiAgICpcbiAgICovXG4gIHByb3RlY3RlZCBhYnN0cmFjdCBnZXRSZXF1ZXN0TWV0aG9kKHJlcTogYW55KTogc3RyaW5nO1xuXG4gIHByb3RlY3RlZCBpbmRleE9mKGNvbGxlY3Rpb246IGFueVtdLCBpZDogbnVtYmVyKSB7XG4gICAgcmV0dXJuIGNvbGxlY3Rpb24uZmluZEluZGV4KChpdGVtOiBhbnkpID0+IGl0ZW0uaWQgPT09IGlkKTtcbiAgfVxuXG4gIC8qKiBQYXJzZSB0aGUgaWQgYXMgYSBudW1iZXIuIFJldHVybiBvcmlnaW5hbCB2YWx1ZSBpZiBub3QgYSBudW1iZXIuICovXG4gIHByb3RlY3RlZCBwYXJzZUlkKGNvbGxlY3Rpb246IGFueVtdLCBjb2xsZWN0aW9uTmFtZTogc3RyaW5nLCBpZDogc3RyaW5nKTogYW55IHtcbiAgICBpZiAoIXRoaXMuaXNDb2xsZWN0aW9uSWROdW1lcmljKGNvbGxlY3Rpb24sIGNvbGxlY3Rpb25OYW1lKSkge1xuICAgICAgLy8gQ2FuJ3QgY29uZmlybSB0aGF0IGBpZGAgaXMgYSBudW1lcmljIHR5cGU7IGRvbid0IHBhcnNlIGFzIGEgbnVtYmVyXG4gICAgICAvLyBvciBlbHNlIGAnNDInYCAtPiBgNDJgIGFuZCBfZ2V0IGJ5IGlkXyBmYWlscy5cbiAgICAgIHJldHVybiBpZDtcbiAgICB9XG4gICAgY29uc3QgaWROdW0gPSBwYXJzZUZsb2F0KGlkKTtcbiAgICByZXR1cm4gaXNOYU4oaWROdW0pID8gaWQgOiBpZE51bTtcbiAgfVxuXG4gIC8qKlxuICAgKiByZXR1cm4gdHJ1ZSBpZiBjYW4gZGV0ZXJtaW5lIHRoYXQgdGhlIGNvbGxlY3Rpb24ncyBgaXRlbS5pZGAgaXMgYSBudW1iZXJcbiAgICogVGhpcyBpbXBsZW1lbnRhdGlvbiBjYW4ndCB0ZWxsIGlmIHRoZSBjb2xsZWN0aW9uIGlzIGVtcHR5IHNvIGl0IGFzc3VtZXMgTk9cbiAgICogKi9cbiAgcHJvdGVjdGVkIGlzQ29sbGVjdGlvbklkTnVtZXJpYzxUIGV4dGVuZHMge2lkOiBhbnl9Pihjb2xsZWN0aW9uOiBUW10sIGNvbGxlY3Rpb25OYW1lOiBzdHJpbmcpOlxuICAgICAgYm9vbGVhbiB7XG4gICAgLy8gY29sbGVjdGlvbk5hbWUgbm90IHVzZWQgbm93IGJ1dCBvdmVycmlkZSBtaWdodCBtYWludGFpbiBjb2xsZWN0aW9uIHR5cGUgaW5mb3JtYXRpb25cbiAgICAvLyBzbyB0aGF0IGl0IGNvdWxkIGtub3cgdGhlIHR5cGUgb2YgdGhlIGBpZGAgZXZlbiB3aGVuIHRoZSBjb2xsZWN0aW9uIGlzIGVtcHR5LlxuICAgIHJldHVybiAhIShjb2xsZWN0aW9uICYmIGNvbGxlY3Rpb25bMF0pICYmIHR5cGVvZiBjb2xsZWN0aW9uWzBdLmlkID09PSAnbnVtYmVyJztcbiAgfVxuXG4gIC8qKlxuICAgKiBQYXJzZXMgdGhlIHJlcXVlc3QgVVJMIGludG8gYSBgUGFyc2VkUmVxdWVzdFVybGAgb2JqZWN0LlxuICAgKiBQYXJzaW5nIGRlcGVuZHMgdXBvbiBjZXJ0YWluIHZhbHVlcyBvZiBgY29uZmlnYDogYGFwaUJhc2VgLCBgaG9zdGAsIGFuZCBgdXJsUm9vdGAuXG4gICAqXG4gICAqIENvbmZpZ3VyaW5nIHRoZSBgYXBpQmFzZWAgeWllbGRzIHRoZSBtb3N0IGludGVyZXN0aW5nIGNoYW5nZXMgdG8gYHBhcnNlUmVxdWVzdFVybGAgYmVoYXZpb3I6XG4gICAqICAgV2hlbiBhcGlCYXNlPXVuZGVmaW5lZCBhbmQgdXJsPSdodHRwOi8vbG9jYWxob3N0L2FwaS9jb2xsZWN0aW9uLzQyJ1xuICAgKiAgICAge2Jhc2U6ICdhcGkvJywgY29sbGVjdGlvbk5hbWU6ICdjb2xsZWN0aW9uJywgaWQ6ICc0MicsIC4uLn1cbiAgICogICBXaGVuIGFwaUJhc2U9J3NvbWUvYXBpL3Jvb3QvJyBhbmQgdXJsPSdodHRwOi8vbG9jYWxob3N0L3NvbWUvYXBpL3Jvb3QvY29sbGVjdGlvbidcbiAgICogICAgIHtiYXNlOiAnc29tZS9hcGkvcm9vdC8nLCBjb2xsZWN0aW9uTmFtZTogJ2NvbGxlY3Rpb24nLCBpZDogdW5kZWZpbmVkLCAuLi59XG4gICAqICAgV2hlbiBhcGlCYXNlPScvJyBhbmQgdXJsPSdodHRwOi8vbG9jYWxob3N0L2NvbGxlY3Rpb24nXG4gICAqICAgICB7YmFzZTogJy8nLCBjb2xsZWN0aW9uTmFtZTogJ2NvbGxlY3Rpb24nLCBpZDogdW5kZWZpbmVkLCAuLi59XG4gICAqXG4gICAqIFRoZSBhY3R1YWwgYXBpIGJhc2Ugc2VnbWVudCB2YWx1ZXMgYXJlIGlnbm9yZWQuIE9ubHkgdGhlIG51bWJlciBvZiBzZWdtZW50cyBtYXR0ZXJzLlxuICAgKiBUaGUgZm9sbG93aW5nIGFwaSBiYXNlIHN0cmluZ3MgYXJlIGNvbnNpZGVyZWQgaWRlbnRpY2FsOiAnYS9iJyB+ICdzb21lL2FwaS8nIH4gYHR3by9zZWdtZW50cydcbiAgICpcbiAgICogVG8gcmVwbGFjZSB0aGlzIGRlZmF1bHQgbWV0aG9kLCBhc3NpZ24geW91ciBhbHRlcm5hdGl2ZSB0byB5b3VyXG4gICAqIEluTWVtRGJTZXJ2aWNlWydwYXJzZVJlcXVlc3RVcmwnXVxuICAgKi9cbiAgcHJvdGVjdGVkIHBhcnNlUmVxdWVzdFVybCh1cmw6IHN0cmluZyk6IFBhcnNlZFJlcXVlc3RVcmwge1xuICAgIHRyeSB7XG4gICAgICBjb25zdCBsb2MgPSB0aGlzLmdldExvY2F0aW9uKHVybCk7XG4gICAgICBsZXQgZHJvcCA9ICh0aGlzLmNvbmZpZy5yb290UGF0aCB8fCAnJykubGVuZ3RoO1xuICAgICAgbGV0IHVybFJvb3QgPSAnJztcbiAgICAgIGlmIChsb2MuaG9zdCAhPT0gdGhpcy5jb25maWcuaG9zdCkge1xuICAgICAgICAvLyB1cmwgZm9yIGEgc2VydmVyIG9uIGEgZGlmZmVyZW50IGhvc3QhXG4gICAgICAgIC8vIGFzc3VtZSBpdCdzIGNvbGxlY3Rpb24gaXMgYWN0dWFsbHkgaGVyZSB0b28uXG4gICAgICAgIGRyb3AgPSAxOyAgLy8gdGhlIGxlYWRpbmcgc2xhc2hcbiAgICAgICAgdXJsUm9vdCA9IGxvYy5wcm90b2NvbCArICcvLycgKyBsb2MuaG9zdCArICcvJztcbiAgICAgIH1cbiAgICAgIGNvbnN0IHBhdGggPSBsb2MucGF0aC5zdWJzdHJpbmcoZHJvcCk7XG4gICAgICBjb25zdCBwYXRoU2VnbWVudHMgPSBwYXRoLnNwbGl0KCcvJyk7XG4gICAgICBsZXQgc2VnbWVudEluZGV4ID0gMDtcblxuICAgICAgLy8gYXBpQmFzZTogdGhlIGZyb250IHBhcnQgb2YgdGhlIHBhdGggZGV2b3RlZCB0byBnZXR0aW5nIHRvIHRoZSBhcGkgcm91dGVcbiAgICAgIC8vIEFzc3VtZXMgZmlyc3QgcGF0aCBzZWdtZW50IGlmIG5vIGNvbmZpZy5hcGlCYXNlXG4gICAgICAvLyBlbHNlIGlnbm9yZXMgYXMgbWFueSBwYXRoIHNlZ21lbnRzIGFzIGFyZSBpbiBjb25maWcuYXBpQmFzZVxuICAgICAgLy8gRG9lcyBOT1QgY2FyZSB3aGF0IHRoZSBhcGkgYmFzZSBjaGFycyBhY3R1YWxseSBhcmUuXG4gICAgICBsZXQgYXBpQmFzZTogc3RyaW5nO1xuICAgICAgaWYgKHRoaXMuY29uZmlnLmFwaUJhc2UgPT0gbnVsbCkge1xuICAgICAgICBhcGlCYXNlID0gcGF0aFNlZ21lbnRzW3NlZ21lbnRJbmRleCsrXTtcbiAgICAgIH0gZWxzZSB7XG4gICAgICAgIGFwaUJhc2UgPSByZW1vdmVUcmFpbGluZ1NsYXNoKHRoaXMuY29uZmlnLmFwaUJhc2UudHJpbSgpKTtcbiAgICAgICAgaWYgKGFwaUJhc2UpIHtcbiAgICAgICAgICBzZWdtZW50SW5kZXggPSBhcGlCYXNlLnNwbGl0KCcvJykubGVuZ3RoO1xuICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgIHNlZ21lbnRJbmRleCA9IDA7ICAvLyBubyBhcGkgYmFzZSBhdCBhbGw7IHVud2lzZSBidXQgYWxsb3dlZC5cbiAgICAgICAgfVxuICAgICAgfVxuICAgICAgYXBpQmFzZSArPSAnLyc7XG5cbiAgICAgIGxldCBjb2xsZWN0aW9uTmFtZSA9IHBhdGhTZWdtZW50c1tzZWdtZW50SW5kZXgrK107XG4gICAgICAvLyBpZ25vcmUgYW55dGhpbmcgYWZ0ZXIgYSAnLicgKGUuZy4sdGhlIFwianNvblwiIGluIFwiY3VzdG9tZXJzLmpzb25cIilcbiAgICAgIGNvbGxlY3Rpb25OYW1lID0gY29sbGVjdGlvbk5hbWUgJiYgY29sbGVjdGlvbk5hbWUuc3BsaXQoJy4nKVswXTtcblxuICAgICAgY29uc3QgaWQgPSBwYXRoU2VnbWVudHNbc2VnbWVudEluZGV4KytdO1xuICAgICAgY29uc3QgcXVlcnkgPSB0aGlzLmNyZWF0ZVF1ZXJ5TWFwKGxvYy5xdWVyeSk7XG4gICAgICBjb25zdCByZXNvdXJjZVVybCA9IHVybFJvb3QgKyBhcGlCYXNlICsgY29sbGVjdGlvbk5hbWUgKyAnLyc7XG4gICAgICByZXR1cm4ge2FwaUJhc2UsIGNvbGxlY3Rpb25OYW1lLCBpZCwgcXVlcnksIHJlc291cmNlVXJsfTtcbiAgICB9IGNhdGNoIChlcnIpIHtcbiAgICAgIGNvbnN0IG1zZyA9IGB1bmFibGUgdG8gcGFyc2UgdXJsICcke3VybH0nOyBvcmlnaW5hbCBlcnJvcjogJHtlcnIubWVzc2FnZX1gO1xuICAgICAgdGhyb3cgbmV3IEVycm9yKG1zZyk7XG4gICAgfVxuICB9XG5cbiAgLy8gQ3JlYXRlIGVudGl0eVxuICAvLyBDYW4gdXBkYXRlIGFuIGV4aXN0aW5nIGVudGl0eSB0b28gaWYgcG9zdDQwOSBpcyBmYWxzZS5cbiAgcHJvdGVjdGVkIHBvc3Qoe2NvbGxlY3Rpb24sIGNvbGxlY3Rpb25OYW1lLCBoZWFkZXJzLCBpZCwgcmVxLCByZXNvdXJjZVVybCwgdXJsfTogUmVxdWVzdEluZm8pOlxuICAgICAgUmVzcG9uc2VPcHRpb25zIHtcbiAgICBjb25zdCBpdGVtID0gdGhpcy5jbG9uZSh0aGlzLmdldEpzb25Cb2R5KHJlcSkpO1xuXG4gICAgaWYgKGl0ZW0uaWQgPT0gbnVsbCkge1xuICAgICAgdHJ5IHtcbiAgICAgICAgaXRlbS5pZCA9IGlkIHx8IHRoaXMuZ2VuSWQoY29sbGVjdGlvbiwgY29sbGVjdGlvbk5hbWUpO1xuICAgICAgfSBjYXRjaCAoZXJyKSB7XG4gICAgICAgIGNvbnN0IGVtc2c6IHN0cmluZyA9IGVyci5tZXNzYWdlIHx8ICcnO1xuICAgICAgICBpZiAoL2lkIHR5cGUgaXMgbm9uLW51bWVyaWMvLnRlc3QoZW1zZykpIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVFcnJvclJlc3BvbnNlT3B0aW9ucyh1cmwsIFNUQVRVUy5VTlBST0NFU1NBQkxFX0VOVFJZLCBlbXNnKTtcbiAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICByZXR1cm4gdGhpcy5jcmVhdGVFcnJvclJlc3BvbnNlT3B0aW9ucyhcbiAgICAgICAgICAgICAgdXJsLCBTVEFUVVMuSU5URVJOQUxfU0VSVkVSX0VSUk9SLFxuICAgICAgICAgICAgICBgRmFpbGVkIHRvIGdlbmVyYXRlIG5ldyBpZCBmb3IgJyR7Y29sbGVjdGlvbk5hbWV9J2ApO1xuICAgICAgICB9XG4gICAgICB9XG4gICAgfVxuXG4gICAgaWYgKGlkICYmIGlkICE9PSBpdGVtLmlkKSB7XG4gICAgICByZXR1cm4gdGhpcy5jcmVhdGVFcnJvclJlc3BvbnNlT3B0aW9ucyhcbiAgICAgICAgICB1cmwsIFNUQVRVUy5CQURfUkVRVUVTVCwgYFJlcXVlc3QgaWQgZG9lcyBub3QgbWF0Y2ggaXRlbS5pZGApO1xuICAgIH0gZWxzZSB7XG4gICAgICBpZCA9IGl0ZW0uaWQ7XG4gICAgfVxuICAgIGNvbnN0IGV4aXN0aW5nSXggPSB0aGlzLmluZGV4T2YoY29sbGVjdGlvbiwgaWQpO1xuICAgIGNvbnN0IGJvZHkgPSB0aGlzLmJvZGlmeShpdGVtKTtcblxuICAgIGlmIChleGlzdGluZ0l4ID09PSAtMSkge1xuICAgICAgY29sbGVjdGlvbi5wdXNoKGl0ZW0pO1xuICAgICAgaGVhZGVycy5zZXQoJ0xvY2F0aW9uJywgcmVzb3VyY2VVcmwgKyAnLycgKyBpZCk7XG4gICAgICByZXR1cm4ge2hlYWRlcnMsIGJvZHksIHN0YXR1czogU1RBVFVTLkNSRUFURUR9O1xuICAgIH0gZWxzZSBpZiAodGhpcy5jb25maWcucG9zdDQwOSkge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgdXJsLCBTVEFUVVMuQ09ORkxJQ1QsXG4gICAgICAgICAgYCcke2NvbGxlY3Rpb25OYW1lfScgaXRlbSB3aXRoIGlkPScke1xuICAgICAgICAgICAgICBpZH0gZXhpc3RzIGFuZCBtYXkgbm90IGJlIHVwZGF0ZWQgd2l0aCBQT1NUOyB1c2UgUFVUIGluc3RlYWQuYCk7XG4gICAgfSBlbHNlIHtcbiAgICAgIGNvbGxlY3Rpb25bZXhpc3RpbmdJeF0gPSBpdGVtO1xuICAgICAgcmV0dXJuIHRoaXMuY29uZmlnLnBvc3QyMDQgPyB7aGVhZGVycywgc3RhdHVzOiBTVEFUVVMuTk9fQ09OVEVOVH0gOiAgLy8gc3VjY2Vzc2Z1bDsgbm8gY29udGVudFxuICAgICAgICAgIHtoZWFkZXJzLCBib2R5LCBzdGF0dXM6IFNUQVRVUy5PS307ICAvLyBzdWNjZXNzZnVsOyByZXR1cm4gZW50aXR5XG4gICAgfVxuICB9XG5cbiAgLy8gVXBkYXRlIGV4aXN0aW5nIGVudGl0eVxuICAvLyBDYW4gY3JlYXRlIGFuIGVudGl0eSB0b28gaWYgcHV0NDA0IGlzIGZhbHNlLlxuICBwcm90ZWN0ZWQgcHV0KHtjb2xsZWN0aW9uLCBjb2xsZWN0aW9uTmFtZSwgaGVhZGVycywgaWQsIHJlcSwgdXJsfTogUmVxdWVzdEluZm8pOiBSZXNwb25zZU9wdGlvbnMge1xuICAgIGNvbnN0IGl0ZW0gPSB0aGlzLmNsb25lKHRoaXMuZ2V0SnNvbkJvZHkocmVxKSk7XG4gICAgaWYgKGl0ZW0uaWQgPT0gbnVsbCkge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgdXJsLCBTVEFUVVMuTk9UX0ZPVU5ELCBgTWlzc2luZyAnJHtjb2xsZWN0aW9uTmFtZX0nIGlkYCk7XG4gICAgfVxuICAgIGlmIChpZCAmJiBpZCAhPT0gaXRlbS5pZCkge1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgdXJsLCBTVEFUVVMuQkFEX1JFUVVFU1QsIGBSZXF1ZXN0IGZvciAnJHtjb2xsZWN0aW9uTmFtZX0nIGlkIGRvZXMgbm90IG1hdGNoIGl0ZW0uaWRgKTtcbiAgICB9IGVsc2Uge1xuICAgICAgaWQgPSBpdGVtLmlkO1xuICAgIH1cbiAgICBjb25zdCBleGlzdGluZ0l4ID0gdGhpcy5pbmRleE9mKGNvbGxlY3Rpb24sIGlkKTtcbiAgICBjb25zdCBib2R5ID0gdGhpcy5ib2RpZnkoaXRlbSk7XG5cbiAgICBpZiAoZXhpc3RpbmdJeCA+IC0xKSB7XG4gICAgICBjb2xsZWN0aW9uW2V4aXN0aW5nSXhdID0gaXRlbTtcbiAgICAgIHJldHVybiB0aGlzLmNvbmZpZy5wdXQyMDQgPyB7aGVhZGVycywgc3RhdHVzOiBTVEFUVVMuTk9fQ09OVEVOVH0gOiAgLy8gc3VjY2Vzc2Z1bDsgbm8gY29udGVudFxuICAgICAgICAgIHtoZWFkZXJzLCBib2R5LCBzdGF0dXM6IFNUQVRVUy5PS307ICAvLyBzdWNjZXNzZnVsOyByZXR1cm4gZW50aXR5XG4gICAgfSBlbHNlIGlmICh0aGlzLmNvbmZpZy5wdXQ0MDQpIHtcbiAgICAgIC8vIGl0ZW0gdG8gdXBkYXRlIG5vdCBmb3VuZDsgdXNlIFBPU1QgdG8gY3JlYXRlIG5ldyBpdGVtIGZvciB0aGlzIGlkLlxuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMoXG4gICAgICAgICAgdXJsLCBTVEFUVVMuTk9UX0ZPVU5ELFxuICAgICAgICAgIGAnJHtjb2xsZWN0aW9uTmFtZX0nIGl0ZW0gd2l0aCBpZD0nJHtcbiAgICAgICAgICAgICAgaWR9IG5vdCBmb3VuZCBhbmQgbWF5IG5vdCBiZSBjcmVhdGVkIHdpdGggUFVUOyB1c2UgUE9TVCBpbnN0ZWFkLmApO1xuICAgIH0gZWxzZSB7XG4gICAgICAvLyBjcmVhdGUgbmV3IGl0ZW0gZm9yIGlkIG5vdCBmb3VuZFxuICAgICAgY29sbGVjdGlvbi5wdXNoKGl0ZW0pO1xuICAgICAgcmV0dXJuIHtoZWFkZXJzLCBib2R5LCBzdGF0dXM6IFNUQVRVUy5DUkVBVEVEfTtcbiAgICB9XG4gIH1cblxuICBwcm90ZWN0ZWQgcmVtb3ZlQnlJZChjb2xsZWN0aW9uOiBhbnlbXSwgaWQ6IG51bWJlcikge1xuICAgIGNvbnN0IGl4ID0gdGhpcy5pbmRleE9mKGNvbGxlY3Rpb24sIGlkKTtcbiAgICBpZiAoaXggPiAtMSkge1xuICAgICAgY29sbGVjdGlvbi5zcGxpY2UoaXgsIDEpO1xuICAgICAgcmV0dXJuIHRydWU7XG4gICAgfVxuICAgIHJldHVybiBmYWxzZTtcbiAgfVxuXG4gIC8qKlxuICAgKiBUZWxsIHlvdXIgaW4tbWVtIFwiZGF0YWJhc2VcIiB0byByZXNldC5cbiAgICogcmV0dXJucyBPYnNlcnZhYmxlIG9mIHRoZSBkYXRhYmFzZSBiZWNhdXNlIHJlc2V0dGluZyBpdCBjb3VsZCBiZSBhc3luY1xuICAgKi9cbiAgcHJvdGVjdGVkIHJlc2V0RGIocmVxSW5mbz86IFJlcXVlc3RJbmZvKTogT2JzZXJ2YWJsZTxib29sZWFuPiB7XG4gICAgdGhpcy5kYlJlYWR5U3ViamVjdCAmJiB0aGlzLmRiUmVhZHlTdWJqZWN0Lm5leHQoZmFsc2UpO1xuICAgIGNvbnN0IGRiID0gdGhpcy5pbk1lbURiU2VydmljZS5jcmVhdGVEYihyZXFJbmZvKTtcbiAgICBjb25zdCBkYiQgPSBkYiBpbnN0YW5jZW9mIE9ic2VydmFibGUgP1xuICAgICAgICBkYiA6XG4gICAgICAgIHR5cGVvZiAoZGIgYXMgYW55KS50aGVuID09PSAnZnVuY3Rpb24nID8gZnJvbShkYiBhcyBQcm9taXNlPGFueT4pIDogb2YoZGIpO1xuICAgIGRiJC5waXBlKGZpcnN0KCkpLnN1YnNjcmliZSgoZDoge30pID0+IHtcbiAgICAgIHRoaXMuZGIgPSBkO1xuICAgICAgdGhpcy5kYlJlYWR5U3ViamVjdCAmJiB0aGlzLmRiUmVhZHlTdWJqZWN0Lm5leHQodHJ1ZSk7XG4gICAgfSk7XG4gICAgcmV0dXJuIHRoaXMuZGJSZWFkeTtcbiAgfVxufVxuIl19