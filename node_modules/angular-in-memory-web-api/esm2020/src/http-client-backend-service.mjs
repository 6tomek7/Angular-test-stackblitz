/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */
import { XhrFactory } from '@angular/common';
import { HttpHeaders, HttpParams, HttpResponse, HttpXhrBackend } from '@angular/common/http';
import { Inject, Injectable, Optional } from '@angular/core';
import { map } from 'rxjs/operators';
import { BackendService } from './backend-service';
import { STATUS } from './http-status-codes';
import { InMemoryBackendConfig, InMemoryBackendConfigArgs, InMemoryDbService } from './interfaces';
import * as i0 from "@angular/core";
import * as i1 from "./interfaces";
import * as i2 from "@angular/common";
/**
 * For Angular `HttpClient` simulate the behavior of a RESTy web api
 * backed by the simple in-memory data store provided by the injected `InMemoryDbService`.
 * Conforms mostly to behavior described here:
 * https://www.restapitutorial.com/lessons/httpmethods.html
 *
 * ### Usage
 *
 * Create an in-memory data store class that implements `InMemoryDbService`.
 * Call `config` static method with this service class and optional configuration object:
 * ```
 * // other imports
 * import { HttpClientModule } from '@angular/common/http';
 * import { HttpClientInMemoryWebApiModule } from 'angular-in-memory-web-api';
 *
 * import { InMemHeroService, inMemConfig } from '../api/in-memory-hero.service';
 * @NgModule({
 *  imports: [
 *    HttpModule,
 *    HttpClientInMemoryWebApiModule.forRoot(InMemHeroService, inMemConfig),
 *    ...
 *  ],
 *  ...
 * })
 * export class AppModule { ... }
 * ```
 */
export class HttpClientBackendService extends BackendService {
    constructor(inMemDbService, config, xhrFactory) {
        super(inMemDbService, config);
        this.xhrFactory = xhrFactory;
    }
    handle(req) {
        try {
            return this.handleRequest(req);
        }
        catch (error) {
            const err = error.message || error;
            const resOptions = this.createErrorResponseOptions(req.url, STATUS.INTERNAL_SERVER_ERROR, `${err}`);
            return this.createResponse$(() => resOptions);
        }
    }
    getJsonBody(req) {
        return req.body;
    }
    getRequestMethod(req) {
        return (req.method || 'get').toLowerCase();
    }
    createHeaders(headers) {
        return new HttpHeaders(headers);
    }
    createQueryMap(search) {
        const map = new Map();
        if (search) {
            const params = new HttpParams({ fromString: search });
            params.keys().forEach(p => map.set(p, params.getAll(p) || []));
        }
        return map;
    }
    createResponse$fromResponseOptions$(resOptions$) {
        return resOptions$.pipe(map(opts => new HttpResponse(opts)));
    }
    createPassThruBackend() {
        try {
            return new HttpXhrBackend(this.xhrFactory);
        }
        catch (ex) {
            ex.message = 'Cannot create passThru404 backend; ' + (ex.message || '');
            throw ex;
        }
    }
}
HttpClientBackendService.ɵfac = i0.ɵɵngDeclareFactory({ minVersion: "12.0.0", version: "13.1.0-next.2", ngImport: i0, type: HttpClientBackendService, deps: [{ token: i1.InMemoryDbService }, { token: InMemoryBackendConfig, optional: true }, { token: i2.XhrFactory }], target: i0.ɵɵFactoryTarget.Injectable });
HttpClientBackendService.ɵprov = i0.ɵɵngDeclareInjectable({ minVersion: "12.0.0", version: "13.1.0-next.2", ngImport: i0, type: HttpClientBackendService });
i0.ɵɵngDeclareClassMetadata({ minVersion: "12.0.0", version: "13.1.0-next.2", ngImport: i0, type: HttpClientBackendService, decorators: [{
            type: Injectable
        }], ctorParameters: function () { return [{ type: i1.InMemoryDbService }, { type: i1.InMemoryBackendConfigArgs, decorators: [{
                    type: Inject,
                    args: [InMemoryBackendConfig]
                }, {
                    type: Optional
                }] }, { type: i2.XhrFactory }]; } });
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaHR0cC1jbGllbnQtYmFja2VuZC1zZXJ2aWNlLmpzIiwic291cmNlUm9vdCI6IiIsInNvdXJjZXMiOlsiLi4vLi4vLi4vLi4vLi4vLi4vLi4vcGFja2FnZXMvbWlzYy9hbmd1bGFyLWluLW1lbW9yeS13ZWItYXBpL3NyYy9odHRwLWNsaWVudC1iYWNrZW5kLXNlcnZpY2UudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6IkFBQUE7Ozs7OztHQU1HO0FBRUgsT0FBTyxFQUFDLFVBQVUsRUFBQyxNQUFNLGlCQUFpQixDQUFDO0FBQzNDLE9BQU8sRUFBeUIsV0FBVyxFQUFFLFVBQVUsRUFBZSxZQUFZLEVBQUUsY0FBYyxFQUFDLE1BQU0sc0JBQXNCLENBQUM7QUFDaEksT0FBTyxFQUFDLE1BQU0sRUFBRSxVQUFVLEVBQUUsUUFBUSxFQUFDLE1BQU0sZUFBZSxDQUFDO0FBRTNELE9BQU8sRUFBQyxHQUFHLEVBQUMsTUFBTSxnQkFBZ0IsQ0FBQztBQUVuQyxPQUFPLEVBQUMsY0FBYyxFQUFDLE1BQU0sbUJBQW1CLENBQUM7QUFDakQsT0FBTyxFQUFDLE1BQU0sRUFBQyxNQUFNLHFCQUFxQixDQUFDO0FBQzNDLE9BQU8sRUFBQyxxQkFBcUIsRUFBRSx5QkFBeUIsRUFBRSxpQkFBaUIsRUFBa0IsTUFBTSxjQUFjLENBQUM7Ozs7QUFFbEg7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0dBMEJHO0FBRUgsTUFBTSxPQUFPLHdCQUF5QixTQUFRLGNBQWM7SUFDMUQsWUFDSSxjQUFpQyxFQUNVLE1BQWlDLEVBQ3BFLFVBQXNCO1FBQ2hDLEtBQUssQ0FBQyxjQUFjLEVBQUUsTUFBTSxDQUFDLENBQUM7UUFEcEIsZUFBVSxHQUFWLFVBQVUsQ0FBWTtJQUVsQyxDQUFDO0lBRUQsTUFBTSxDQUFDLEdBQXFCO1FBQzFCLElBQUk7WUFDRixPQUFPLElBQUksQ0FBQyxhQUFhLENBQUMsR0FBRyxDQUFDLENBQUM7U0FFaEM7UUFBQyxPQUFPLEtBQUssRUFBRTtZQUNkLE1BQU0sR0FBRyxHQUFHLEtBQUssQ0FBQyxPQUFPLElBQUksS0FBSyxDQUFDO1lBQ25DLE1BQU0sVUFBVSxHQUNaLElBQUksQ0FBQywwQkFBMEIsQ0FBQyxHQUFHLENBQUMsR0FBRyxFQUFFLE1BQU0sQ0FBQyxxQkFBcUIsRUFBRSxHQUFHLEdBQUcsRUFBRSxDQUFDLENBQUM7WUFDckYsT0FBTyxJQUFJLENBQUMsZUFBZSxDQUFDLEdBQUcsRUFBRSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1NBQy9DO0lBQ0gsQ0FBQztJQUVrQixXQUFXLENBQUMsR0FBcUI7UUFDbEQsT0FBTyxHQUFHLENBQUMsSUFBSSxDQUFDO0lBQ2xCLENBQUM7SUFFa0IsZ0JBQWdCLENBQUMsR0FBcUI7UUFDdkQsT0FBTyxDQUFDLEdBQUcsQ0FBQyxNQUFNLElBQUksS0FBSyxDQUFDLENBQUMsV0FBVyxFQUFFLENBQUM7SUFDN0MsQ0FBQztJQUVrQixhQUFhLENBQUMsT0FBbUM7UUFDbEUsT0FBTyxJQUFJLFdBQVcsQ0FBQyxPQUFPLENBQUMsQ0FBQztJQUNsQyxDQUFDO0lBRWtCLGNBQWMsQ0FBQyxNQUFjO1FBQzlDLE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxFQUFvQixDQUFDO1FBQ3hDLElBQUksTUFBTSxFQUFFO1lBQ1YsTUFBTSxNQUFNLEdBQUcsSUFBSSxVQUFVLENBQUMsRUFBQyxVQUFVLEVBQUUsTUFBTSxFQUFDLENBQUMsQ0FBQztZQUNwRCxNQUFNLENBQUMsSUFBSSxFQUFFLENBQUMsT0FBTyxDQUFDLENBQUMsQ0FBQyxFQUFFLENBQUMsR0FBRyxDQUFDLEdBQUcsQ0FBQyxDQUFDLEVBQUUsTUFBTSxDQUFDLE1BQU0sQ0FBQyxDQUFDLENBQUMsSUFBSSxFQUFFLENBQUMsQ0FBQyxDQUFDO1NBQ2hFO1FBQ0QsT0FBTyxHQUFHLENBQUM7SUFDYixDQUFDO0lBRWtCLG1DQUFtQyxDQUFDLFdBQXdDO1FBRTdGLE9BQU8sV0FBVyxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsSUFBSSxDQUFDLEVBQUUsQ0FBQyxJQUFJLFlBQVksQ0FBTSxJQUFJLENBQUMsQ0FBQyxDQUFDLENBQUM7SUFDcEUsQ0FBQztJQUVrQixxQkFBcUI7UUFDdEMsSUFBSTtZQUNGLE9BQU8sSUFBSSxjQUFjLENBQUMsSUFBSSxDQUFDLFVBQVUsQ0FBQyxDQUFDO1NBQzVDO1FBQUMsT0FBTyxFQUFFLEVBQUU7WUFDWCxFQUFFLENBQUMsT0FBTyxHQUFHLHFDQUFxQyxHQUFHLENBQUMsRUFBRSxDQUFDLE9BQU8sSUFBSSxFQUFFLENBQUMsQ0FBQztZQUN4RSxNQUFNLEVBQUUsQ0FBQztTQUNWO0lBQ0gsQ0FBQzs7Z0lBckRVLHdCQUF3QixtREFHdkIscUJBQXFCO29JQUh0Qix3QkFBd0I7c0dBQXhCLHdCQUF3QjtrQkFEcEMsVUFBVTs7MEJBSUosTUFBTTsyQkFBQyxxQkFBcUI7OzBCQUFHLFFBQVEiLCJzb3VyY2VzQ29udGVudCI6WyIvKipcbiAqIEBsaWNlbnNlXG4gKiBDb3B5cmlnaHQgR29vZ2xlIExMQyBBbGwgUmlnaHRzIFJlc2VydmVkLlxuICpcbiAqIFVzZSBvZiB0aGlzIHNvdXJjZSBjb2RlIGlzIGdvdmVybmVkIGJ5IGFuIE1JVC1zdHlsZSBsaWNlbnNlIHRoYXQgY2FuIGJlXG4gKiBmb3VuZCBpbiB0aGUgTElDRU5TRSBmaWxlIGF0IGh0dHBzOi8vYW5ndWxhci5pby9saWNlbnNlXG4gKi9cblxuaW1wb3J0IHtYaHJGYWN0b3J5fSBmcm9tICdAYW5ndWxhci9jb21tb24nO1xuaW1wb3J0IHtIdHRwQmFja2VuZCwgSHR0cEV2ZW50LCBIdHRwSGVhZGVycywgSHR0cFBhcmFtcywgSHR0cFJlcXVlc3QsIEh0dHBSZXNwb25zZSwgSHR0cFhockJhY2tlbmR9IGZyb20gJ0Bhbmd1bGFyL2NvbW1vbi9odHRwJztcbmltcG9ydCB7SW5qZWN0LCBJbmplY3RhYmxlLCBPcHRpb25hbH0gZnJvbSAnQGFuZ3VsYXIvY29yZSc7XG5pbXBvcnQge09ic2VydmFibGV9IGZyb20gJ3J4anMnO1xuaW1wb3J0IHttYXB9IGZyb20gJ3J4anMvb3BlcmF0b3JzJztcblxuaW1wb3J0IHtCYWNrZW5kU2VydmljZX0gZnJvbSAnLi9iYWNrZW5kLXNlcnZpY2UnO1xuaW1wb3J0IHtTVEFUVVN9IGZyb20gJy4vaHR0cC1zdGF0dXMtY29kZXMnO1xuaW1wb3J0IHtJbk1lbW9yeUJhY2tlbmRDb25maWcsIEluTWVtb3J5QmFja2VuZENvbmZpZ0FyZ3MsIEluTWVtb3J5RGJTZXJ2aWNlLCBSZXNwb25zZU9wdGlvbnN9IGZyb20gJy4vaW50ZXJmYWNlcyc7XG5cbi8qKlxuICogRm9yIEFuZ3VsYXIgYEh0dHBDbGllbnRgIHNpbXVsYXRlIHRoZSBiZWhhdmlvciBvZiBhIFJFU1R5IHdlYiBhcGlcbiAqIGJhY2tlZCBieSB0aGUgc2ltcGxlIGluLW1lbW9yeSBkYXRhIHN0b3JlIHByb3ZpZGVkIGJ5IHRoZSBpbmplY3RlZCBgSW5NZW1vcnlEYlNlcnZpY2VgLlxuICogQ29uZm9ybXMgbW9zdGx5IHRvIGJlaGF2aW9yIGRlc2NyaWJlZCBoZXJlOlxuICogaHR0cHM6Ly93d3cucmVzdGFwaXR1dG9yaWFsLmNvbS9sZXNzb25zL2h0dHBtZXRob2RzLmh0bWxcbiAqXG4gKiAjIyMgVXNhZ2VcbiAqXG4gKiBDcmVhdGUgYW4gaW4tbWVtb3J5IGRhdGEgc3RvcmUgY2xhc3MgdGhhdCBpbXBsZW1lbnRzIGBJbk1lbW9yeURiU2VydmljZWAuXG4gKiBDYWxsIGBjb25maWdgIHN0YXRpYyBtZXRob2Qgd2l0aCB0aGlzIHNlcnZpY2UgY2xhc3MgYW5kIG9wdGlvbmFsIGNvbmZpZ3VyYXRpb24gb2JqZWN0OlxuICogYGBgXG4gKiAvLyBvdGhlciBpbXBvcnRzXG4gKiBpbXBvcnQgeyBIdHRwQ2xpZW50TW9kdWxlIH0gZnJvbSAnQGFuZ3VsYXIvY29tbW9uL2h0dHAnO1xuICogaW1wb3J0IHsgSHR0cENsaWVudEluTWVtb3J5V2ViQXBpTW9kdWxlIH0gZnJvbSAnYW5ndWxhci1pbi1tZW1vcnktd2ViLWFwaSc7XG4gKlxuICogaW1wb3J0IHsgSW5NZW1IZXJvU2VydmljZSwgaW5NZW1Db25maWcgfSBmcm9tICcuLi9hcGkvaW4tbWVtb3J5LWhlcm8uc2VydmljZSc7XG4gKiBATmdNb2R1bGUoe1xuICogIGltcG9ydHM6IFtcbiAqICAgIEh0dHBNb2R1bGUsXG4gKiAgICBIdHRwQ2xpZW50SW5NZW1vcnlXZWJBcGlNb2R1bGUuZm9yUm9vdChJbk1lbUhlcm9TZXJ2aWNlLCBpbk1lbUNvbmZpZyksXG4gKiAgICAuLi5cbiAqICBdLFxuICogIC4uLlxuICogfSlcbiAqIGV4cG9ydCBjbGFzcyBBcHBNb2R1bGUgeyAuLi4gfVxuICogYGBgXG4gKi9cbkBJbmplY3RhYmxlKClcbmV4cG9ydCBjbGFzcyBIdHRwQ2xpZW50QmFja2VuZFNlcnZpY2UgZXh0ZW5kcyBCYWNrZW5kU2VydmljZSBpbXBsZW1lbnRzIEh0dHBCYWNrZW5kIHtcbiAgY29uc3RydWN0b3IoXG4gICAgICBpbk1lbURiU2VydmljZTogSW5NZW1vcnlEYlNlcnZpY2UsXG4gICAgICBASW5qZWN0KEluTWVtb3J5QmFja2VuZENvbmZpZykgQE9wdGlvbmFsKCkgY29uZmlnOiBJbk1lbW9yeUJhY2tlbmRDb25maWdBcmdzLFxuICAgICAgcHJpdmF0ZSB4aHJGYWN0b3J5OiBYaHJGYWN0b3J5KSB7XG4gICAgc3VwZXIoaW5NZW1EYlNlcnZpY2UsIGNvbmZpZyk7XG4gIH1cblxuICBoYW5kbGUocmVxOiBIdHRwUmVxdWVzdDxhbnk+KTogT2JzZXJ2YWJsZTxIdHRwRXZlbnQ8YW55Pj4ge1xuICAgIHRyeSB7XG4gICAgICByZXR1cm4gdGhpcy5oYW5kbGVSZXF1ZXN0KHJlcSk7XG5cbiAgICB9IGNhdGNoIChlcnJvcikge1xuICAgICAgY29uc3QgZXJyID0gZXJyb3IubWVzc2FnZSB8fCBlcnJvcjtcbiAgICAgIGNvbnN0IHJlc09wdGlvbnMgPVxuICAgICAgICAgIHRoaXMuY3JlYXRlRXJyb3JSZXNwb25zZU9wdGlvbnMocmVxLnVybCwgU1RBVFVTLklOVEVSTkFMX1NFUlZFUl9FUlJPUiwgYCR7ZXJyfWApO1xuICAgICAgcmV0dXJuIHRoaXMuY3JlYXRlUmVzcG9uc2UkKCgpID0+IHJlc09wdGlvbnMpO1xuICAgIH1cbiAgfVxuXG4gIHByb3RlY3RlZCBvdmVycmlkZSBnZXRKc29uQm9keShyZXE6IEh0dHBSZXF1ZXN0PGFueT4pOiBhbnkge1xuICAgIHJldHVybiByZXEuYm9keTtcbiAgfVxuXG4gIHByb3RlY3RlZCBvdmVycmlkZSBnZXRSZXF1ZXN0TWV0aG9kKHJlcTogSHR0cFJlcXVlc3Q8YW55Pik6IHN0cmluZyB7XG4gICAgcmV0dXJuIChyZXEubWV0aG9kIHx8ICdnZXQnKS50b0xvd2VyQ2FzZSgpO1xuICB9XG5cbiAgcHJvdGVjdGVkIG92ZXJyaWRlIGNyZWF0ZUhlYWRlcnMoaGVhZGVyczoge1tpbmRleDogc3RyaW5nXTogc3RyaW5nO30pOiBIdHRwSGVhZGVycyB7XG4gICAgcmV0dXJuIG5ldyBIdHRwSGVhZGVycyhoZWFkZXJzKTtcbiAgfVxuXG4gIHByb3RlY3RlZCBvdmVycmlkZSBjcmVhdGVRdWVyeU1hcChzZWFyY2g6IHN0cmluZyk6IE1hcDxzdHJpbmcsIHN0cmluZ1tdPiB7XG4gICAgY29uc3QgbWFwID0gbmV3IE1hcDxzdHJpbmcsIHN0cmluZ1tdPigpO1xuICAgIGlmIChzZWFyY2gpIHtcbiAgICAgIGNvbnN0IHBhcmFtcyA9IG5ldyBIdHRwUGFyYW1zKHtmcm9tU3RyaW5nOiBzZWFyY2h9KTtcbiAgICAgIHBhcmFtcy5rZXlzKCkuZm9yRWFjaChwID0+IG1hcC5zZXQocCwgcGFyYW1zLmdldEFsbChwKSB8fCBbXSkpO1xuICAgIH1cbiAgICByZXR1cm4gbWFwO1xuICB9XG5cbiAgcHJvdGVjdGVkIG92ZXJyaWRlIGNyZWF0ZVJlc3BvbnNlJGZyb21SZXNwb25zZU9wdGlvbnMkKHJlc09wdGlvbnMkOiBPYnNlcnZhYmxlPFJlc3BvbnNlT3B0aW9ucz4pOlxuICAgICAgT2JzZXJ2YWJsZTxIdHRwUmVzcG9uc2U8YW55Pj4ge1xuICAgIHJldHVybiByZXNPcHRpb25zJC5waXBlKG1hcChvcHRzID0+IG5ldyBIdHRwUmVzcG9uc2U8YW55PihvcHRzKSkpO1xuICB9XG5cbiAgcHJvdGVjdGVkIG92ZXJyaWRlIGNyZWF0ZVBhc3NUaHJ1QmFja2VuZCgpIHtcbiAgICB0cnkge1xuICAgICAgcmV0dXJuIG5ldyBIdHRwWGhyQmFja2VuZCh0aGlzLnhockZhY3RvcnkpO1xuICAgIH0gY2F0Y2ggKGV4KSB7XG4gICAgICBleC5tZXNzYWdlID0gJ0Nhbm5vdCBjcmVhdGUgcGFzc1RocnU0MDQgYmFja2VuZDsgJyArIChleC5tZXNzYWdlIHx8ICcnKTtcbiAgICAgIHRocm93IGV4O1xuICAgIH1cbiAgfVxufVxuIl19