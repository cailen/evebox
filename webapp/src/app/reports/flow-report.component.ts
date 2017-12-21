/* Copyright (c) 2016 Jason Ish
 * All rights reserved.
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions
 * are met:
 *
 * 1. Redistributions of source code must retain the above copyright
 *    notice, this list of conditions and the following disclaimer.
 * 2. Redistributions in binary form must reproduce the above copyright
 *    notice, this list of conditions and the following disclaimer in the
 *    documentation and/or other materials provided with the distribution.
 *
 * THIS SOFTWARE IS PROVIDED ``AS IS'' AND ANY EXPRESS OR IMPLIED
 * WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED WARRANTIES OF
 * MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
 * DISCLAIMED. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY DIRECT,
 * INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
 * (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
 * SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION)
 * HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT,
 * STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING
 * IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 * POSSIBILITY OF SUCH DAMAGE.
 */

import {Component, OnInit, OnDestroy} from "@angular/core";
import {ActivatedRoute, Params} from "@angular/router";
import {ReportsService} from "./reports.service";
import {AppService, AppEvent, AppEventCode} from "../app.service";
import {TopNavService} from "../topnav.service";
import {ElasticSearchService} from "../elasticsearch.service";
import {loadingAnimation} from "../animations";
import {EveboxSubscriptionTracker} from "../subscription-tracker";
import {ApiService, ReportAggOptions} from "../api.service";

import * as moment from "moment";

@Component({
    template: `
      <div class="content" [@loadingState]="(loading > 0) ? 'true' : 'false'">

        <loading-spinner [loading]="loading > 0"></loading-spinner>

        <div class="row">
          <div class="col-md-6 col-sm-6">
            <button type="button" class="btn btn-secondary" (click)="refresh()">
              Refresh
            </button>
          </div>
          <div class="col-md-6 col-sm-6">
            <evebox-filter-input [queryString]="queryString"></evebox-filter-input>
          </div>
        </div>

        <br/>

        <metrics-graphic *ngIf="eventsOverTime"
                         graphId="eventsOverTime"
                         title="Netflow Events Over Time"
                         [data]="eventsOverTime"></metrics-graphic>

        <div class="row">

          <div class="col-md-6">
            <report-data-table *ngIf="topClientsByFlows"
                               title="Top Clients By Flow Count"
                               [rows]="topClientsByFlows"
                               [headers]="['Flows', 'Client IP']"></report-data-table>
          </div>

          <div class="col-md-6">
            <report-data-table *ngIf="topServersByFlows"
                               title="Top Servers By Flow Count"
                               [rows]="topServersByFlows"
                               [headers]="['Flows', 'Server IP']"></report-data-table>
          </div>

        </div>

        <br/>

        <div *ngIf="topFlowsByAge" class="card">
          <div class="card-header">
            <b>Top Flows by Age</b>
          </div>
          <eveboxEventTable2 [rows]="topFlowsByAge"
                             [showEventType]="false"
                             [showActiveEvent]="false"></eveboxEventTable2>
        </div>

        <br/>

      </div>`,
    animations: [
        loadingAnimation,
    ]
})
export class FlowReportComponent implements OnInit, OnDestroy {

    eventsOverTime: any[];

    topClientsByFlows: any[];
    topServersByFlows: any[];

    topFlowsByAge: any[];

    loading = 0;

    queryString = "";

    subTracker: EveboxSubscriptionTracker = new EveboxSubscriptionTracker();

    constructor(private appService: AppService,
                private route: ActivatedRoute,
                private reportsService: ReportsService,
                private topNavService: TopNavService,
                private api: ApiService,
                private elasticsearch: ElasticSearchService) {
    }

    ngOnInit() {

        this.subTracker.subscribe(this.route.params, (params: Params) => {
            this.queryString = params["q"] || "";
            this.refresh();
        });

        this.subTracker.subscribe(this.appService, (event: AppEvent) => {
            if (event.event == AppEventCode.TIME_RANGE_CHANGED) {
                this.refresh();
            }
        });

    }

    ngOnDestroy() {
        this.subTracker.unsubscribe();
    }

    load(fn: any) {
        this.loading++;
        fn().then(() => {
            this.loading--;
        });
    }

    refresh() {

        let range = this.topNavService.getTimeRangeAsSeconds();
        let now = moment();

        this.load(() => {
            return this.api.reportHistogram({
                timeRange: range,
                interval: this.reportsService.histogramTimeInterval(range),
                eventType: "flow",
                queryString: this.queryString,
            }).then((response: any) => {
                this.eventsOverTime = response.data.map((x: any) => {
                    return {
                        date: moment(x.key).toDate(),
                        value: x.count
                    };
                });
            });
        });

        let aggOptions: ReportAggOptions = {
            timeRange: range,
            eventType: "flow",
            size: 10,
            queryString: this.queryString,
        };

        this.load(() => {
            return this.api.reportAgg("src_ip", aggOptions)
                .then((response: any) => {
                    this.topClientsByFlows = response.data;
                });
        });

        this.load(() => {
            return this.api.reportAgg("dest_ip", aggOptions)
                .then((response: any) => {
                    this.topServersByFlows = response.data;
                });
        });

        let query: any = {
            query: {
                bool: {
                    filter: [
                        // Somewhat limit to eve events only.
                        {exists: {field: "event_type"}},
                        {term: {event_type: "flow"}}
                    ]
                }
            },
            size: 0,
            sort: [
                {"@timestamp": {order: "desc"}}
            ],
            aggs: {
                topFlowsByAge: {
                    top_hits: {
                        sort: [
                            {
                                "flow.age": {
                                    order: "desc",
                                    unmapped_type: "long"
                                }
                            }
                        ],
                        size: 10,
                    }
                }
            }
        };

        if (this.queryString && this.queryString != "") {
            query.query.filtered.query = {
                query_string: {
                    query: this.queryString
                }
            };
        }

        this.elasticsearch.addTimeRangeFilter(query, now, range);

        this.load(() => {
            return this.elasticsearch.search(query).then((response: any) => {
                this.topFlowsByAge = response.aggregations.topFlowsByAge.hits.hits;
                this.loading--;
            });
        });

    }
}