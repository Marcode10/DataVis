/*global $, google, InfoBox */
var simulation_manager = (function(){
    google.maps.visualRefresh = true;

    var ua_is_mobile = navigator.userAgent.indexOf('iPhone') !== -1 || navigator.userAgent.indexOf('Android') !== -1;

    var config = (function(){
        var params = {};

        return {
            init: function() {
                $.ajax({
                    url: 'static/js/config.js',
                    dataType: 'json',
                    async: false,
                    success: function(config_params) {
                        params = config_params;

                        // Override config with the QS params
                        var url_parts = window.location.href.split('?');
                        if (url_parts.length === 2) {
                            var qs_groups = url_parts[1].split('&');
                            $.each(qs_groups, function(index, qs_group){
                                var qs_parts = qs_group.split('=');
                                var key = qs_parts[0];

                                // Backwards compatibility
                                switch (key) {
                                    case 'zoom':
                                        key = 'zoom.start';
                                        break;
                                    case 'x':
                                        key = 'center.x';
                                        break;
                                    case 'y':
                                        key = 'center.y';
                                        break;
                                }

                                var param_value = decodeURIComponent(qs_parts[1]);

                                params[key] = param_value;
                            });
                        }
                    },
                    error: function(a) {
                        alert('Broken JSON in static/js/config.js');
                    }
                });
            },
            getParam: function(key) {
                return (typeof params[key] === 'undefined') ? null : params[key];
            }
        };
    })();

    var map = null;

    var simulation_vehicles = {};

    var listener_helpers = (function(){
        var listeners = {};

        function notify(type) {
            if (typeof listeners[type] === 'undefined') {
                return;
            }

            $.each(listeners[type], function(i, fn){
                fn();
            });
        }

        function subscribe(type, fn) {
            if (typeof listeners[type] === 'undefined') {
                listeners[type] = [];
            }

            listeners[type].push(fn);
        }

        return {
            notify: notify,
            subscribe: subscribe
        };
    })();

    var stationsPool = (function(){
        var stations = {};

        function get(id) {
            return (typeof stations[id]) === 'undefined' ? '' : stations[id].get('name');
        }

        function location_get(id) {
            return (typeof stations[id]) === 'undefined' ? '' : stations[id].get('location');
        }

        function addFeatures(features) {
            $.each(features, function(index, feature) {
                var station_id, station_name;
                if (typeof(feature.properties.stop_id) === 'undefined') {
                    // Custom GeoJSON support
                    station_id = feature.properties.station_id;
                    station_name = feature.properties.name;
                } else {
                    // GTFS support
                    station_id = feature.properties.stop_id;
                    station_name = feature.properties.stop_name;
                }

                var station = new google.maps.MVCObject();
                station.set('name', station_name);

                var station_x = parseFloat(feature.geometry.coordinates[0]);
                var station_y = parseFloat(feature.geometry.coordinates[1]);
                station.set('location', new google.maps.LatLng(station_y, station_x));

                stations[station_id] = station;
            });
        }

        return {
            get: get,
            addFeatures: addFeatures,
            location_get: location_get
        };
    })();

    // Routes manager.
    // Roles:
    // - keep a reference for the routes between stations
    //      i.e. (Z??rich HB-Bern, Z??rich HB-Olten, Olten-Bern)
    //      Note: one route can contain one or more edges (the low-level entity in the simulation graph)
    // - interpolate position at given percent along a route
    var linesPool = (function() {
        var network_lines = {};
        var routes = {};
        var route_highlight = new google.maps.Polyline({
            path: [],
            strokeColor: "white",
            strokeOpacity: 0.8,
            strokeWeight: 3,
            map: null,
            icons: [{
                icon: {
                    path: 'M 0,-2 0,2',
                    strokeColor: 'black',
                    strokeOpacity: 1.0
                },
                repeat: '40px'
            }],
            timer: null
        });


        // TODO - that can be a nice feature request for google.maps.geometry lib
        function positionOnRouteAtPercentGet(ab_edges, percent) {
            function routeIsDetailedAtPercent() {
                for (var k=0; k<route.detailed_parts.length; k++) {
                    if ((percent >= route.detailed_parts[k].start) && (percent < route.detailed_parts[k].end)) {
                        return true;
                    }
                }

                return false;
            }

            var route = routes[ab_edges];

            var dAC = route.length*percent;

            var is_detailed = map_helpers.isDetailView() ? routeIsDetailedAtPercent() : false;
            var position_data = positionDataGet(route, dAC, is_detailed);
            if (position_data !== null) {
                position_data.is_detailed = is_detailed;
            }

            return position_data;
        }

        function routeAdd(ab_edges) {
            if (typeof routes[ab_edges] !== 'undefined') {
                return;
            }

            var edges = ab_edges.split(',');
            var routePoints = [];
            var dAB = 0;
            $.each(edges, function(k, edgeID) {
                if (edgeID.substr(0, 1) === '-') {
                    edgeID = edgeID.substr(1);
                    var points = network_lines[edgeID].points.slice().reverse();
                } else {
                    var points = network_lines[edgeID].points;
                }
                routePoints = routePoints.concat(points);
                dAB += network_lines[edgeID].length;
            });

            var routeDetailedParts = [];
            var routeDetailedParts_i = 0;
            var is_detailed_prev = false;
            var dAC = 0;
            $.each(edges, function(k, edgeID) {
                if (edgeID.substr(0, 1) === '-') {
                    edgeID = edgeID.substr(1);
                }

                var is_detailed = network_lines[edgeID].is_detailed;
                if (is_detailed) {
                    if (is_detailed_prev === false) {
                        routeDetailedParts[routeDetailedParts_i] = {
                            start: dAC / dAB,
                            end: 1
                        };
                    }
                } else {
                    if (is_detailed_prev) {
                        routeDetailedParts[routeDetailedParts_i].end = dAC / dAB;
                        routeDetailedParts_i += 1;
                    }
                }

                is_detailed_prev = is_detailed;

                dAC += network_lines[edgeID].length;
            });

            var route = {
                points: routePoints,
                length: dAB,
                detailed_parts: routeDetailedParts
            };

            routes[ab_edges] = route;
        }

        function lengthGet(ab_edges) {
            return routes[ab_edges].length;
        }

        function routeHighlight(vehicle) {
            var points = [];
            if (vehicle.source === 'gtfs') {
                points = routes[vehicle.shape_id].points;
            } else {
                $.each(vehicle.edges, function(k, ab_edges){
                    if (k === 0) { return; }
                    points = points.concat(routes[ab_edges].points);
                });
            }

            route_highlight.setPath(points);
            route_highlight.setMap(map);

            var icon_offset = 0;
            route_highlight.set('timer', setInterval(function(){
                if (icon_offset > 39) {
                    icon_offset = 0;
                } else {
                    icon_offset += 2;
                }

                var icons = route_highlight.get('icons');
                icons[0].offset = icon_offset + 'px';
                route_highlight.set('icons', icons);
            }, 20));
        }

        function routeHighlightRemove() {
            route_highlight.setMap(null);
            clearInterval(route_highlight.get('timer'));
        }

        function loadEncodedEdges(edges) {
            $.each(edges, function(edge_id, encoded_edge) {
                network_lines[edge_id] = {
                    points: google.maps.geometry.encoding.decodePath(encoded_edge),
                    is_detailed: false
                };
            });
        }

        function loadGeoJSONEdges(features) {
            $.each(features, function(index, feature) {
                var edge_coords = [];
                $.each(feature.geometry.coordinates, function(i2, feature_coord){
                    edge_coords.push(new google.maps.LatLng(feature_coord[1], feature_coord[0]));
                });

                var edge_id = feature.properties.edge_id;

                network_lines[edge_id] = {
                    points: edge_coords,
                    is_detailed: feature.properties.detailed === 'yes',
                    length: parseFloat(google.maps.geometry.spherical.computeLength(edge_coords).toFixed(3))
                };
            });
        }

        function loadGeoJSONShapes(features) {
            $.each(features, function(index, feature) {
                var shape_id = feature.properties.shape_id;

                var points = [];
                $.each(feature.geometry.coordinates, function(i2, feature_coord){
                    points.push(new google.maps.LatLng(feature_coord[1], feature_coord[0]));
                });

                var dAB = parseFloat(google.maps.geometry.spherical.computeLength(points).toFixed(3));

                var route = {
                    points: points,
                    length: dAB,
                    detailed_parts: []
                };

                routes[shape_id] = route;
            });
        }

        function positionDataGet(route, dAC, is_detailed) {
            var dC = 0;

            for (var i=1; i<route.points.length; i++) {
                var pA = route.points[i-1];
                var pB = route.points[i];
                var d12 = google.maps.geometry.spherical.computeDistanceBetween(pA, pB);
                if ((dC + d12) > dAC) {
                    var data = {
                        position: google.maps.geometry.spherical.interpolate(pA, pB, (dAC - dC)/d12)
                    };
                    if (is_detailed) {
                        data.heading = google.maps.geometry.spherical.computeHeading(pA, pB);
                    }

                    return data;
                }
                dC += d12;
            }

            return null;
        }

        function projectDistanceAlongRoute(ab_edges, dAC) {
            var route = routes[ab_edges];
            return positionDataGet(route, dAC, true);
        }

        return {
            positionGet: positionOnRouteAtPercentGet,
            routeAdd: routeAdd,
            lengthGet: lengthGet,
            routeHighlight: routeHighlight,
            routeHighlightRemove: routeHighlightRemove,
            loadEncodedEdges: loadEncodedEdges,
            loadGeoJSONEdges: loadGeoJSONEdges,
            loadGeoJSONShapes: loadGeoJSONShapes,
            projectDistanceAlongRoute: projectDistanceAlongRoute
        };
    })();

    // Time manager
    // Roles:
    // - manages the current number of seconds that passed since midnight
    var timer = (function(){
        var timer_refresh = 100;
        var ts_midnight = null;
        var ts_now = null;
        var ts_minute = null;

        var seconds_multiply = null;

        function init() {

          var HOURS = [
          { name: "00:00", minutes: 6 },
          { name: "01:00", minutes: 6 },
          { name: "02:00", minutes: 6 },
          { name: "03:00", minutes: 6 },
          { name: "04:00", minutes: 6 },
          { name: "05:00", minutes: 6 },
          { name: "06:00", minutes: 6 },
          { name: "07:00", minutes: 6 },
          { name: "08:00", minutes: 6 },
          { name: "09:00", minutes: 6 },
          { name: "10:00", minutes: 6 },
          { name: "11:00", minutes: 6 },
          { name: "12:00", minutes: 6 },
          { name: "13:00", minutes: 6 },
          { name: "14:00", minutes: 6 },
          { name: "15:00", minutes: 6 },
          { name: "16:00", minutes: 6 },
          { name: "17:00", minutes: 6 },
          { name: "18:00", minutes: 6 },
          { name: "19:00", minutes: 6 },
          { name: "20:00", minutes: 6 },
          { name: "21:00", minutes: 6 },
          { name: "22:00", minutes: 6 },
          { name: "23:00", minutes: 6 }

        ];


        function initScrubber() {
          var $scrubber_inner = $("<div />").attr("id", "scrubber-inner").appendTo("#scrubber");

          var minute_number = 0,
              minute_width = Math.floor(window.innerWidth/(24*6 + 24)),
              scrolling = minute_width < 2;
          if (scrolling) minute_width = 2;
          var calendar_width = minute_width*(24*6),
              margin = scrolling ? 0 : (window.innerWidth - calendar_width)/2;
          for (var i = 0; i < HOURS.length; i++) {
            var $hour = $("<div />")
                .attr("class", "hour " + HOURS[i].name)
                .css("left" , margin + minute_number * minute_width + (i * 1) - 105 + "px")
                // here the calculation could be optimized , because 105 here is a not a fixed Number
                .css("width" ,minute_width * HOURS[i].minutes + 1 + "px")
                .appendTo($scrubber_inner);
            $("<div />").attr("class", "label").text(HOURS[i].name).appendTo($hour);
            for (var j = 0; j < HOURS[i].minutes; j++) {
              var $minute = $("<div />").attr("class", "minute").attr("id", "minute-" + minute_number)
                .css("position", "absolute")
                .css("top", 0)
                .css( "left" , j * minute_width + "px")
                .css( "width", minute_width + "px")
                .appendTo($hour)
                .on("click", clickminute);
              //$("<div />").attr("class", "label").text(j).appendTo($minute);
              //$("<div />").attr("class", "label").appendTo($minute);
              $("<div />").attr("class", "load-progress")
              .css( "width", minute_width + "px")
              .css("height","0px")
              .appendTo($minute);
              minute_number++;
            }
          }

        }
        function clickminute(){
            var minute_number = this.id.substring("minute-".length);
            var hour_id = parseInt(minute_number/6);
            var minute_id = (minute_number % 6 )*10;
            var d_new = new Date(ts_now * 1000);
            d_new.setHours(hour_id);
            d_new.setMinutes(minute_id);
            d_new.setSeconds(0);
            d_new.setMilliseconds(0);
            ts_now = d_new.getTime()/1000;
          }


            (function(){
                var d = new Date();
                // var d = new Date('2020-05-14T10:00:00Z');

                var hms = config.getParam('hms');

                ts_now = d.getTime() / 1000;

                d.setHours(0);
                d.setMinutes(0);
                d.setSeconds(0);
                d.setMilliseconds(0);
                ts_midnight = d.getTime() / 1000;
            })();

            if($('#one-time').hasClass('checked')){
              seconds_multiply = 1;
            }else if ($('#five-times').hasClass('checked')) {
              seconds_multiply = 5;
            }else if ($('#ten-times').hasClass('checked')) {
              seconds_multiply = 10;
            }else {
              seconds_multiply = 1;
            }

            /* FLAG : SPEED*/

            $('#one-time').on('click',onetime);
            $('#five-times').on('click',fivetimes);
            $('#ten-times').on('click',tentimes);

            function onetime() {
              if(seconds_multiply == 1) return;
              $('#one-time').addClass('checked');
              seconds_multiply = 1;
              if($('#five-times').hasClass('checked')){
                $('#five-times').removeClass('checked');
              }else if ($('#ten-times').hasClass('checked')) {
                $('#ten-times').removeClass('checked');
              }
            }

            function fivetimes(){
              if(seconds_multiply == 5) return;
              $('#five-times').addClass('checked');
              seconds_multiply = 5;
              if($('#one-time').hasClass('checked')){
                $('#one-time').removeClass('checked');
              }else if ($('#ten-times').hasClass('checked')) {
                $('#ten-times').removeClass('checked');
              }
            }

            function tentimes(){
              if(seconds_multiply == 10) return;
              $('#ten-times').addClass('checked');
              seconds_multiply = 10;
              if($('#one-time').hasClass('checked')){
                $('#one-time').removeClass('checked');
              }else if ($('#five-times').hasClass('checked')) {
                $('#five-times').removeClass('checked');
              }
            }
/*
            seconds_multiply = parseFloat($('#time_multiply').val());
            $('#time_multiply').change(function(){
                seconds_multiply = parseInt($(this).val(), 10);
            });
*/

            var timeContainer = $('#day_time');

            function timeIncrement() {
                var d_now = new Date(ts_now * 1000);

                var ts_minute_new = d_now.getMinutes();
                if (ts_minute !== ts_minute_new) {
                    if (ts_minute !== null) {
                        listener_helpers.notify('minute_changed');
                    }
                    ts_minute = ts_minute_new;
                }

                timeContainer.text(getHMS());

                ts_now += (timer_refresh / 1000) * seconds_multiply;
                setTimeout(timeIncrement, timer_refresh);
            }
            initScrubber();
            timeIncrement();
        }

        function pad2Dec(what) {
            return (what < 10 ? '0' + what : what);
        }

        function getHMS(ts) {
            ts = ts || ts_now;

            var d = new Date(ts * 1000);

            var hours = pad2Dec(d.getHours());
            var minutes = pad2Dec(d.getMinutes());
            var seconds = pad2Dec(d.getSeconds());

            return hours + ':' + minutes + ':' + seconds;
        }
        function getYMD(ts) {
            ts = ts || ts_now;

            var d = new Date(ts * 1000);
            const ye = new Intl.DateTimeFormat('en', { year: 'numeric' }).format(d)
            const mo = new Intl.DateTimeFormat('en', { month: '2-digit' }).format(d)
            const da = new Intl.DateTimeFormat('en', { day: '2-digit' }).format(d)
            var ymd = ye+mo+da
            // console.log(ymd);
            return ymd;
        }

        return {
            init: init,
            getTS: function(ts) {
                return ts_now;
            },
            getHM: function(ts) {
                var hms = getHMS(ts);
                return hms.substring(0, 2) + ':' + hms.substring(3, 5);
            },
            getYMD: function(ts) {
                var ymd = getYMD(ts);
                return ymd;
                // return hms.substring(0, 2) + ':' + hms.substring(3, 5);
            },
            getTSMidnight: function() {
                return ts_midnight;
            },
            getRefreshValue: function() {
                return timer_refresh;
            },
            getHMS2TS: function(hms) {
                var hms_parts = hms.split(':');

                var hours = parseInt(hms_parts[0], 10);
                var minutes = parseInt(hms_parts[1], 10);
                var seconds = parseInt(hms_parts[2], 10);

                return ts_midnight + hours * 3600 + minutes * 60 + seconds;
            }
        };
    })();

    var simulation_panel = (function(){
        var selected_vehicle = null;

        function Toggler(el_id) {
            var el = $(el_id);
            el.attr('data-value-original', el.val());

            var subscriber_types = {
                'enable': [function(){
                    el.addClass('toggled');
                    el.val(el.attr('data-value-toggle'));
                }],
                'disable': [function(){
                    el.removeClass('toggled');
                    el.val(el.attr('data-value-original'));
                }]
            };
            this.subscriber_types = subscriber_types;

            el.click(function(){
                var subscribers = el.hasClass('toggled') ? subscriber_types.disable : subscriber_types.enable;
                $.each(subscribers, function(index, fn){
                    fn();
                });
            });
        }
        Toggler.prototype.subscribe = function(type, fn) {
            this.subscriber_types[type].push(fn);
        };
        Toggler.prototype.trigger = function(type) {
            $.each(this.subscriber_types[type], function(index, fn){
                fn();
            });
        };

        var vehicle_follow = (function(){
            listener_helpers.subscribe('map_init', function(){
                function stop_following() {
                    if (selected_vehicle === null) {
                        return;
                    }

                    stop();
                }

                google.maps.event.addListener(map, 'dragstart', stop_following);
                google.maps.event.addListener(map, 'click', stop_following);
                google.maps.event.addListener(map, 'dblclick', stop_following);
            });

            var toggler;
            function init() {
                toggler = new Toggler('#follow_trigger');
                toggler.subscribe('enable', function(){
                    selected_vehicle.marker.set('follow', 'yes-init');
                });
                toggler.subscribe('disable', function(){
                    if (selected_vehicle) {
                        selected_vehicle.marker.set('follow', 'no');
                    }
                    map.unbind('center');
                });
            }

            function start(vehicle) {
                selected_vehicle = vehicle;
                toggler.trigger('enable');
            }

            function stop() {
                toggler.trigger('disable');
            }

            return {
                init: init,
                start: start,
                stop: stop
            };
        })();

        var vehicle_route = (function(){
            var toggler;

            function init() {
                toggler = new Toggler('#route_show_trigger');
                toggler.subscribe('enable', function(){
                    linesPool.routeHighlight(selected_vehicle);
                });
                toggler.subscribe('disable', function(){
                    linesPool.routeHighlightRemove();
                });
            }

            function hide() {
                toggler.trigger('disable');
            }

            return {
                init: init,
                hide: hide
            };
        })();

        function station_info_hide() {
            $('#station_info').addClass('hidden');
        }

        function vehicle_info_display(vehicle) {
            if ((selected_vehicle !== null) && (selected_vehicle.id === vehicle.id)) {
                if (selected_vehicle.marker.get('follow') === 'no') {
                    vehicle_follow.start(selected_vehicle);
                }
                if (selected_vehicle.marker.get('follow') === 'yes') {
                    vehicle_follow.stop();
                }
                return;
            }
            selected_vehicle = vehicle;

            vehicle_follow.stop();
            station_info_hide();
            vehicle_route.hide();

            $('.vehicle_name', $('#vehicle_info')).text(vehicle.name + ' (' + vehicle.id + ')');

            var route_config = config.getParam('routes')[vehicle.route_icon];
            if (route_config) {
                $('.vehicle_name', $('#vehicle_info')).css('background-color', route_config.route_color);
                $('.vehicle_name', $('#vehicle_info')).css('color', route_config.route_text_color);
            }
            // else {
            //     route_config = config.getParam('routes')["re"]
            //     $('.vehicle_name', $('#vehicle_info')).css('background-color', route_config.route_color);
            //     $('.vehicle_name', $('#vehicle_info')).css('color', route_config.route_text_color);
            // }

            var ts = timer.getTS();

            var html_rows = [];
            $.each(vehicle.stations, function(index, stop_id) {
                var s_dep = (typeof vehicle.depS[index] === 'undefined') ? "n/a" : vehicle.depS[index];
                var html_row = '<tr data-dep-sec="' + s_dep + '"><td>' + (index + 1) + '.</td>';

                var station_location = stationsPool.location_get(stop_id);
                if (station_location === null) {
                    html_row += '<td>' + stationsPool.get(stop_id) + '</td>';
                } else {
                    html_row += '<td><a href="#station_id=' + stop_id + '" data-station-id="' + stop_id + '">' + stationsPool.get(stop_id) + '</a></td>';
                }

                var hm_arr = (typeof vehicle.arrS[index - 1] === 'undefined') ? '' : timer.getHM(vehicle.arrS[index - 1]);
                html_row += '<td>' + hm_arr + '</td>';

                var hm_dep = (typeof vehicle.depS[index] === 'undefined') ? '' : timer.getHM(vehicle.depS[index]);
                html_row += '<td>' + hm_dep + '</td></tr>';

                html_rows.push(html_row);
            });

            $('#vehicle_timetable > tbody').html(html_rows.join(''));
            $('#vehicle_timetable tbody tr').each(function(){
                var row_dep_sec = $(this).attr('data-dep-sec');
                if (row_dep_sec === "n/a") {
                    return;
                }
                if (row_dep_sec < ts) {
                    $(this).addClass('passed');
                }
            });
            $('#vehicle_info').removeClass('hidden');
            $('#options-info').addClass('hidden');
        }

        function vehicle_info_hide() {
            vehicle_follow.stop();
            vehicle_route.hide();
            selected_vehicle = null;
            $('#vehicle_info').addClass('hidden');
            $('#options-info').removeClass('hidden');

        }

        function station_info_display(station_id) {
            var hm = timer.getHM();

            var url = config.getParam('api_paths.departures');
            if (url === null) {
                return;
            }

            url = url.replace(/\[station_id\]/, station_id);
            url = url.replace(/\[hhmm\]/, hm.replace(':', ''));

            $.ajax({
                url: url,
                dataType: 'json',
                success: function(vehicles) {
                    vehicle_info_hide();

                    var html_rows = [];
                    $.each(vehicles, function(index, vehicle) {
                        var html_row = '<tr><td>' + (index + 1) + '.</td>';
                        if (typeof simulation_vehicles[vehicle.id] === 'undefined') {
                            html_row += '<td>' + vehicle.name + '</td>';
                        } else {
                            html_row += '<td><a href="#vehicle_id=' + vehicle.id + '" data-vehicle-id="' + vehicle.id + '">' + vehicle.name + '</a></td>';
                        }

                        html_row += '<td>' + stationsPool.get(vehicle.st_b) + '</td>';
                        html_row += '<td>' + timer.getHM(vehicle.dep) + '</td>';
                        html_rows.push(html_row);
                    });
                    $('#station_departures > tbody').html(html_rows.join(''));

                    $('#station_info').removeClass('hidden');
                    $('#options_info').addClass('hidden');
                    $('#options_info').removeClass('expanded');
                    $('.station_name', $('#station_info')).text(stationsPool.get(station_id));
                }
            });
        }

        function init() {
            vehicle_follow.init();
            vehicle_route.init();

            $(document).on("click", '#station_departures tbody tr a', function(){
                var vehicle_id = $(this).attr('data-vehicle-id');
                var vehicle = simulation_vehicles[vehicle_id];
                simulation_panel.displayVehicle(vehicle);
                simulation_panel.followVehicle(vehicle);

                return false;
            });

            $(document).on("click", '#vehicle_timetable tbody tr a', function(){
                var station_id = $(this).attr('data-station-id');
                var station_location = stationsPool.location_get(station_id);
                if (station_location === null) {
                    return false;
                }

                map.setCenter(station_location);
                if (map.getZoom() < config.getParam('zoom.to_stops')) {
                    map.setZoom(config.getParam('zoom.to_stops'));
                }

                vehicle_info_hide();
                station_info_display(station_id);

                return false;
            });

            (function(){
                var location_el = $('#user_location');

                var geolocation_marker = new google.maps.Marker({
                    icon: {
                        url: 'static/images/geolocation-bluedot.png',
                        size: new google.maps.Size(17, 17),
                        origin: new google.maps.Point(0, 0),
                        anchor: new google.maps.Point(8, 8)
                    },
                    map: null,
                    position: new google.maps.LatLng(0, 0)
                });

                var geocoder = new google.maps.Geocoder();

                function zoom_to_geometry(geometry) {
                    if (geometry.viewport) {
                        map.fitBounds(geometry.viewport);
                    } else {
                        map.setCenter(geometry.location);
                        map.setZoom(15);
                    }
                }

                $('#geolocation_click').click(function(){
                    if (navigator.geolocation) {
                        location_el.val('...getting location');
                        navigator.geolocation.getCurrentPosition(function (position) {
                            var latlng = new google.maps.LatLng(position.coords.latitude, position.coords.longitude);
                            zoom_to_geometry({location: latlng});

                            geolocation_marker.setPosition(latlng);
                            if (geolocation_marker.getMap() === null) {
                                geolocation_marker.setMap(map);
                            }

                            geocoder.geocode({latLng: latlng}, function(results, status) {
                                if (status === google.maps.GeocoderStatus.OK) {
                                    location_el.val(results[0].formatted_address);
                                }
                            });
                        });
                    }
                });

                var autocomplete = new google.maps.places.Autocomplete($('#user_location')[0], {
                    types: ['geocode']
                });
                autocomplete.bindTo('bounds', map);
                google.maps.event.addListener(autocomplete, 'place_changed', function(){
                    var place = autocomplete.getPlace();
                    if (place.geometry) {
                        zoom_to_geometry(place.geometry);
                    } else {
                        geocoder.geocode({address: place.name}, function(results, status) {
                            if (status === google.maps.GeocoderStatus.OK) {
                                zoom_to_geometry(results[0].geometry);
                                location_el.val(results[0].formatted_address);
                            }
                        });
                    }
                });
            })();

            $('input.panel_collapsible').click(function() {
                var panel_content = $(this).closest('div[data-type="panel"]').children('div.panel_content');

                if ($(this).hasClass('expanded')) {
                    $(this).removeClass('expanded');
                    panel_content.addClass('hidden');
                } else {
                    $(this).addClass('expanded');
                    panel_content.removeClass('hidden');
                }
            });
        }

        return {
            init: init,
            displayVehicle: vehicle_info_display,
            followVehicle: vehicle_follow.start,
            displayStation: station_info_display
        };
    })();

    var map_helpers = (function(){
        var has_detail_view = false;
        var extended_bounds = null;

        function init(){

          // create the basic map,  with the map_options

            var mapStyles = [
              {
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#f5f5f5"
                  }
                ]
              },
              {
                "elementType": "labels.icon",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#616161"
                  }
                ]
              },
              {
                "elementType": "labels.text.stroke",
                "stylers": [
                  {
                    "color": "#f5f5f5"
                  }
                ]
              },
              {
                "featureType": "administrative",
                "elementType": "geometry",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "administrative.land_parcel",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "administrative.land_parcel",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#bdbdbd"
                  }
                ]
              },
              {
                "featureType": "administrative.neighborhood",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "poi",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "poi",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#eeeeee"
                  }
                ]
              },
              {
                "featureType": "poi",
                "elementType": "labels.text",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "poi",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#757575"
                  }
                ]
              },
              {
                "featureType": "poi.park",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#e5e5e5"
                  }
                ]
              },
              {
                "featureType": "poi.park",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#9e9e9e"
                  }
                ]
              },
              {
                "featureType": "road",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#ffffff"
                  }
                ]
              },
              {
                "featureType": "road",
                "elementType": "labels",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "road",
                "elementType": "labels.icon",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "road.arterial",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#757575"
                  }
                ]
              },
              {
                "featureType": "road.highway",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#dadada"
                  }
                ]
              },
              {
                "featureType": "road.highway",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#616161"
                  }
                ]
              },
              {
                "featureType": "road.local",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#9e9e9e"
                  }
                ]
              },
              {
                "featureType": "transit",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "transit.line",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#e5e5e5"
                  }
                ]
              },
              {
                "featureType": "transit.station",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#eeeeee"
                  }
                ]
              },
              {
                "featureType": "water",
                "elementType": "geometry",
                "stylers": [
                  {
                    "color": "#c9c9c9"
                  }
                ]
              },
              {
                "featureType": "water",
                "elementType": "labels.text",
                "stylers": [
                  {
                    "visibility": "off"
                  }
                ]
              },
              {
                "featureType": "water",
                "elementType": "labels.text.fill",
                "stylers": [
                  {
                    "color": "#9e9e9e"
                  }
                ]
              }
            ];

            var map_inited = false;
            var map_options = {
                zoom: parseInt(config.getParam('zoom.start'), 5),
                center: new google.maps.LatLng(46.8,8.3),
                mapTypeId: config.getParam('map_type_id'),
                styles: mapStyles,
                disableDefaultUI: true,
                zoomControl: true,
                scaleControl: true,
                streetViewControl: false,
                overviewMapControl: true,
                rotateControl: true,
                mapTypeControl: false,
                mapTypeControlOptions: {
                    position: google.maps.ControlPosition.TOP_LEFT,
                    mapTypeIds: [google.maps.MapTypeId.ROADMAP, google.maps.MapTypeId.TERRAIN, google.maps.MapTypeId.SATELLITE, 'stamen']
                }
            };

            if (config.getParam('tilt') !== null) {
                map_options.tilt = parseInt(config.getParam('tilt'), 10);
            }

            if (config.getParam('zoom.min') !== null) {
                map_options.minZoom = parseInt(config.getParam('zoom.min'), 10);
            }

            if (config.getParam('zoom.max') !== null) {
                map_options.maxZoom = parseInt(config.getParam('zoom.max'), 10);
            }

            // create the basic map,  with the map_options
            map = new google.maps.Map(document.getElementById("map_canvas"), map_options);
/*
            var marker = new google.maps.Marker({
              position: new google.maps.LatLng(parseFloat(config.getParam('center.y')), parseFloat(config.getParam('center.x'))),
              map: map
            });*/

            google.maps.event.addDomListener(map, 'idle', function() {
                var recenterButton = document.querySelector("#recenter");
                recenterButton.addEventListener("click", function() {
                    map.setZoom(parseInt(config.getParam('zoom.start'), 5));
                    map.setCenter(new google.maps.LatLng(46.8,8.3));
                });
            });

            var stations_showing = false,
                trains_showing = false,
                map_showing = true,
                routes_showing = false,
                shade_type = "uniform";
                //speed = "1x";

            var type_filter = [ 1.0, 1.0, 1.0, 1.0, 1.0];

            function map_layers_add(){
                var edges_layer;
                var stations_layer;
                var ft_id;
                var switzerland_layer;
                var stations_train_layer;
                var stations_tram_layer;
                var stations_ferry_layer;
                var stations_gondola_layer;

                // GTFS layers - shapes.txt
                ft_id = config.getParam('ft_layer_ids.gtfs_shapes');
                if (ft_id !== null) {

                    edges_layer = new google.maps.Data();
                    edges_layer.loadGeoJson(config.getParam('geojson.gtfs_shapes'));
                    edges_layer.setStyle({
                      strokeWeight: 1,
                      strokeColor: 'green'
                    });
                }

                // GTFS layers - stops.txt
                // GTFS layers - stops.txt
                ft_id = config.getParam('ft_layer_ids.gtfs_stops');
                if (ft_id !== null) {

                    stations_layer = new google.maps.Data();
                    stations_layer.loadGeoJson(config.getParam('geojson.gtfs_stops'));
                    stations_layer.setStyle({
                      icon: 'static/images/stations_icons/stationsicon.png'
                      //fillColor: 'green'
                      //strokeWeight: 1
                    });

                    stations_train_layer = new google.maps.Data();
                    stations_train_layer.loadGeoJson(config.getParam('geojson.gtfs_stops_train'));
                    stations_train_layer.setStyle({
                      icon: 'static/images/stations_icons/stationsicon-train.png'
                      //fillColor: 'green'
                      //strokeWeight: 1
                    });

                    stations_tram_layer = new google.maps.Data();
                    stations_tram_layer.loadGeoJson(config.getParam('geojson.gtfs_stops_tram'));
                    stations_tram_layer.setStyle({
                      icon: 'static/images/stations_icons/stationsicon-tram.png'
                      //fillColor: 'green'
                      //strokeWeight: 1
                    });

                    stations_ferry_layer = new google.maps.Data();
                    stations_ferry_layer.loadGeoJson(config.getParam('geojson.gtfs_stops_ferry'));
                    stations_ferry_layer.setStyle({
                      icon: 'static/images/stations_icons/stationsicon-ferry.png'
                      //fillColor: 'green'
                      //strokeWeight: 1
                    });

                    stations_gondola_layer = new google.maps.Data();
                    stations_gondola_layer.loadGeoJson(config.getParam('geojson.gtfs_stops_gondola'));
                    stations_gondola_layer.setStyle({
                      icon: 'static/images/stations_icons/stationsicon-gondola.png'
                      //fillColor: 'green'
                      //strokeWeight: 1
                    });
                }

                ft_id = config.getParam('ft_layer_ids.swswitzerland');
                if (ft_id !== null) {

                    switzerland_layer = new google.maps.Data();
                    switzerland_layer.loadGeoJson(config.getParam('geojson.gtfs_switzerland'));
                    switzerland_layer.setStyle({
                      //fillColor: 1,
                      strokeColor: 'white',
                      strokeWeight: 3,
                    });
                }

                /* FLAG: SHOW */
                $("#station-toggler").on("click", toggleStations);
                $("#route-toggler").on("click", toggleRoutes);
                $("#map-toggler").on("click",toggleMap);
                //$("#ship-toggler").on("click", toggleShips);
                //$("#train-toggler").on("click", toggleTrains);

                $(".radio").each(function(){
                  if(stations_showing){
                    var clicked = this;
                    $(this).removeClass("disabled");
                    $(".notice1").addClass("transparent");
                    $(this).off("click");
                    $(this).on("click", function() {
                      var shade_type = this.getAttribute("data-value").substr("shade-".length);
                    	if (shade_type == "type") shadeByType();
                    	else shadeUniform();
                  	});
                  }else {
                    $(this).off("click");
                    $(this).on("click",function(){$('.notice1').removeClass("transparent");});
                    $(this).addClass("disabled");
                  }
                });


                $(".filter.color")
              		.each(function() {
              			var station_type = this.getAttribute("data-traffic-type");
              			if(stations_showing) {
                      $(this).removeClass("disabled");
                      $(".notice2").addClass("transparent");
                      $(this).on("click", function() {
                        toggleTrafficType(station_type);
                      });
                    }
                    else {
                      $(this).off("click");
                      $(this).on("click",function(){$('.notice2').removeClass("transparent");});
                      $(this).addClass("disabled");
                    }
              		});
                  function shadeByType() {
                  	$("#dashboard").addClass("color-coded");
                      resetColor();
                  	//}
                  	if(!$('#type').hasClass("checked")) $('#type').addClass("checked");
                    if($('#uniform').hasClass("checked"))$('#uniform').removeClass("checked");
                  	shade_type = "type";

                  }

                  function shadeUniform() {

                  	$("#dashboard").removeClass("color-coded");
                      uniformColor();
                  	shade_type = "uniform";
                    if($('#type').hasClass("checked")) $('#type').removeClass("checked");
                    if(!$('#uniform').hasClass("checked"))$('#uniform').addClass("checked");

                  }

                function toggleStations() {
                  if (stations_showing) hideStations();
                  else showStations();
                }

                function showStations() {
                  if (stations_showing) return;
                  if(shade_type == "uniform"){
                    uniformColor();
                  }
                  $("#station-toggler").addClass("checked");
                  $(".notice2").addClass("transparent");
                  $(".notice1").addClass("transparent");
                  $(".filter.color")
                		.each(function() {
                			var station_type = this.getAttribute("data-traffic-type");
                      $(this).off("click");
                			$(this).on("click", function() { toggleTrafficType(station_type); });
                      $(this).removeClass("disabled")
                		});
                  $(".radio").each(function(){
                      $(this).removeClass("disabled");
                      $(this).off("click");
                      $(this).on("click", function() {
                        var shade_type = this.getAttribute("data-value").substr("shade-".length);
                      	if (shade_type == "type") shadeByType();
                      	else shadeUniform();
                    	});
                  });
                  stations_showing = true;
                  filterMap();
                }

                function hideStations() {
                  if (!stations_showing) return;
                  $("#station-toggler").removeClass("checked");
                  stations_showing = false;
                  $(".filter.color")
                    .each(function() {
                      var station_type = this.getAttribute("data-traffic-type");
                        $(this).off("click");
                        $(this).on("click",function(){$('.notice2').removeClass("transparent");});
                        $(this).addClass("disabled");
                    });
                  $(".radio").each(function(){
                      $(this).off("click");
                      $(this).on("click",function(){$('.notice1').removeClass("transparent");});
                      $(this).addClass("disabled");
                  });
                  filterMap();
                }

                // FLAG : Routes control
                function toggleRoutes() {
                  if (routes_showing) hideRoutes();
                  else showRoutes();
                }
                function showRoutes() {
                  if (routes_showing) return;
                  $("#route-toggler").addClass("checked");
                  edges_layer.setMap(map);
                  routes_showing = true;

                }

                function hideRoutes() {
                  if (!routes_showing) return;
                  $("#route-toggler").removeClass("checked");
                  edges_layer.setMap(null);
                  routes_showing = false;
                }

                function toggleMap() {
                  if (map_showing) hideMap();
                	else showMap();
                }

                function showMap() {
                	if(map_showing) return;
                	//$('#map-canvas').removeClass("transparent");
                  $("#map-toggler").addClass("checked");
                  switzerland_layer.setMap(map);
                  map_showing = true;
                }

                function hideMap() {
                	if (!map_showing) return;
                	//$('#map_canvas').addClass("transparent");
                  $("#map-toggler").removeClass("checked");
                  switzerland_layer.setMap(null);
                  map_showing = false;
                }

                function toggleTrafficType(station_type) {
                	if ($("#filter-type-" + station_type).hasClass("checked")) hideTrafficType(station_type);
                	else showTrafficType(station_type);
                }

                function hideTrafficType(station_type) {
                	$("#filter-type-" + station_type).removeClass("checked");
                	type_filter[station_type] = 0.0;
                	filterMap();
                }

                function showTrafficType(station_type) {
                	$("#filter-type-" + station_type).addClass("checked");
                	type_filter[station_type] = 1.0;
                	filterMap();
                };

                function uniformColor(){
                  stations_train_layer.setStyle({icon: 'static/images/stations_icons/stationsicon.png'});
                  stations_tram_layer.setStyle({icon: 'static/images/stations_icons/stationsicon.png'});
                  stations_ferry_layer.setStyle({icon: 'static/images/stations_icons/stationsicon.png'});
                  stations_gondola_layer.setStyle({icon: 'static/images/stations_icons/stationsicon.png'});
                }

                function resetColor(){
                  stations_train_layer.setStyle({icon: 'static/images/stations_icons/stationsicon-train.png'});
                  stations_tram_layer.setStyle({icon: 'static/images/stations_icons/stationsicon-tram.png'});
                  stations_ferry_layer.setStyle({icon: 'static/images/stations_icons/stationsicon-ferry.png'});
                  stations_gondola_layer.setStyle({icon: 'static/images/stations_icons/stationsicon-gondola.png'});
                }

                function filterMap(){
                  if(stations_showing){
                    if(type_filter[0] == 1.0) stations_tram_layer.setMap(map);
                    else stations_tram_layer.setMap(null);
                    if(type_filter[1] == 1.0) stations_ferry_layer.setMap(map)
                    else stations_ferry_layer.setMap(null);
                    if(type_filter[2] == 1.0) stations_gondola_layer.setMap(map)
                    else stations_gondola_layer.setMap(null);
                    if(type_filter[3] == 1.0) stations_train_layer.setMap(map)
                    else stations_train_layer.setMap(null);
                  }
                  else {
                    stations_tram_layer.setMap(null);
                    stations_ferry_layer.setMap(null);
                    stations_gondola_layer.setMap(null);
                    stations_train_layer.setMap(null);
                  }
                }

                /*  Map initialization*/

                if(map_showing) switzerland_layer.setMap(map);
                if(stations_showing) {
                  uniformColor();
                  filterMap();
                }

                function trigger_toggleLayerVisibility() {
                  if (config.getParam('debug') !== null) {
                      console.log('Center: ' + map.getCenter().toUrlValue());
                      console.log('Zoom: ' + map.getZoom());
                  }

                  function toggleLayerVisibility(layer, hide) {
                      if ((typeof layer) === 'undefined') {
                          return;
                      }

                      if (hide) {
                          if (layer.getMap() !== null) {
                              layer.setMap(null);
                          }
                      } else {
                          if (layer.getMap() === null) {
                              layer.setMap(map);
                          }
                      }
                  }

                  var map_type_id = map.getMapTypeId();
                  var is_satellite = (map_type_id === google.maps.MapTypeId.SATELLITE) && (map.getTilt() === 0);
                  var config_preffix = is_satellite ? 'zoom.satellite' : 'zoom.roadmap';

                  var zoom = map.getZoom();

                  $.each(['stops', 'shapes'], function(k, layer_type){
                      var zoom_min = config.getParam(config_preffix + '.' + layer_type + '_min');
                      if (zoom_min === null) {
                          zoom_min = 0;
                      }

                      var zoom_max = config.getParam(config_preffix + '.' + layer_type + '_max');
                      if (zoom_max === null) {
                          zoom_max = 30;
                      }

                  });

                  // FLAG : showStations or hideStations
                  //if(stations_showing) toggleLayerVisibility(stations_layer,false);

                } // end of trigger_toggleLayerVisibility

                google.maps.event.addListener(map, 'idle', trigger_toggleLayerVisibility);
                google.maps.event.addListener(map, 'maptypeid_changed', trigger_toggleLayerVisibility);
                trigger_toggleLayerVisibility();
            }

            google.maps.event.addListener(map, 'idle', function() {
                if (map_inited === false) {
                    // TODO - FIXME later ?
                    // Kind of a hack, getBounds is ready only after a while since loading, so we hook in the 'idle' event
                    map_inited = true;

                    map_layers_add();
                    listener_helpers.notify('map_init');

                    function update_detail_view_state() {
                        if (map.getMapTypeId() !== google.maps.MapTypeId.SATELLITE) {
                            has_detail_view = false;
                            return;
                        }

                        if (map.getZoom() < 17) {
                            has_detail_view = false;
                            return;
                        }

                        if (map.getTilt() !== 0) {
                            has_detail_view = false;
                            return;
                        }

                        has_detail_view = true;
                    }
                    google.maps.event.addListener(map, 'zoom_changed', update_detail_view_state);
                    google.maps.event.addListener(map, 'tilt_changed', update_detail_view_state);
                    google.maps.event.addListener(map, 'maptypeid_changed', update_detail_view_state);
                    update_detail_view_state();

                    function update_extended_bounds() {
                        var map_bounds = map.getBounds();

                        var bounds_point = map_bounds.getSouthWest();
                        var new_bounds_sw = new google.maps.LatLng(bounds_point.lat() - map_bounds.toSpan().lat(), bounds_point.lng() - map_bounds.toSpan().lng());

                        bounds_point = map_bounds.getNorthEast();
                        var new_bounds_ne = new google.maps.LatLng(bounds_point.lat() + map_bounds.toSpan().lat(), bounds_point.lng() + map_bounds.toSpan().lng());

                        extended_bounds = new google.maps.LatLngBounds(new_bounds_sw, new_bounds_ne);
                    }
                    google.maps.event.addListener(map, 'bounds_changed', update_extended_bounds);
                    update_extended_bounds();
                }
            });
        }

        return {
            init: init,
            isDetailView: function() {
                return has_detail_view;
            },
            getExtendedBounds: function() {
                return extended_bounds;
            }
        };
    })();

    // Vehicle helpers
    // Roles:
    // - check backend for new vehicles
    // - manages vehicle objects(class Vehicle) and animates them (see Vehicle.render method)
    var vehicle_helpers = (function(){
        var vehicle_detect = (function(){
            var track_vehicle_name = null;
            var track_vehicle_id = null;

            function match_by_name(vehicle_name) {
                if (track_vehicle_name === null) {
                    return false;
                }

                vehicle_name = vehicle_name.replace(/[^A-Z0-9]/i, '');
                if (track_vehicle_name !== vehicle_name) {
                    return false;
                }

                return true;
            }

            function match(vehicle_name, vehicle_id) {
                if (track_vehicle_id === null) {
                    track_vehicle_name = config.getParam('vehicle_name');
                    if (track_vehicle_name !== null) {
                        track_vehicle_name = track_vehicle_name.replace(/[^A-Z0-9]/i, '');
                    }

                    track_vehicle_id = config.getParam('vehicle_id');
                }

                if (track_vehicle_id === vehicle_id) {
                    return true;
                }

                return match_by_name(vehicle_name);
            }

            listener_helpers.subscribe('vehicles_load', function(){
                if (config.getParam('action') !== 'vehicle_add') {
                    return;
                }

                function str_hhmm_2_sec_ar(str_hhmm) {
                    var sec_ar = [];
                    $.each(str_hhmm.split('_'), function(index, hhmm){
                        var hhmm_matches = hhmm.match(/([0-9]{2})([0-9]{2})/);
                        sec_ar.push(timer.getHMS2TS(hhmm_matches[1] + ':' + hhmm_matches[2] + ':00'));
                    });
                    return sec_ar;
                }

                var station_ids = config.getParam('station_ids').split('_');
                $.each(station_ids, function(index, station_id_s){
                    station_ids[index] = station_id_s;
                });

                var vehicle_data = {
                    arrs: str_hhmm_2_sec_ar(config.getParam('arrs')),
                    deps: str_hhmm_2_sec_ar(config.getParam('deps')),
                    id: 'custom_vehicle',
                    name: decodeURIComponent(config.getParam('vehicle_name')),
                    sts: station_ids,
                    type: config.getParam('vehicle_type'),
                    edges: []
                };

                var v = new Vehicle(vehicle_data);
                simulation_vehicles[vehicle_data.id] = v;
                v.render();

                simulation_panel.displayVehicle(v);
                simulation_panel.followVehicle(v);
            });

            return {
                match: match
            };
        })();

        // Vehicle icons manager.
        // Roles:
        // - keep a reference for each vehicle type (IC, ICE, etc..)
        var imagesPool = (function(){
            var icons = {};

            function iconGet(type) {
                if (icons[type]) {
                    return icons[type];
                }

                var routes_config = config.getParam('routes');
                if ((typeof routes_config[type]) === 'undefined') {
                    type = "general"
                    // return null;
                }

                if (routes_config[type].icon === false) {
                    return null;
                }

                var url = routes_config[type].icon;

                var icon = {
                    url: url,
                    size: new google.maps.Size(20, 20),
                    origin: new google.maps.Point(0, 0),
                    anchor: new google.maps.Point(10, 10)
                };
                icons[type] = icon;

                return icon;
            }

            var vehicle_detail_base_zoom = 17;
            var vehicle_detail_config = {
                "s-bahn-rear": {
                    base_zoom_width: 33,
                    width: 228
                },
                "s-bahn-middle": {
                    base_zoom_width: 33,
                    width: 247
                },
                "s-bahn-front": {
                    base_zoom_width: 33,
                    width: 239
                },

                "s-bahn_old-rear": {
                    base_zoom_width: 26,
                    width: 153
                },
                "s-bahn_old-middle": {
                    base_zoom_width: 35,
                    width: 228
                },
                "s-bahn_old-front": {
                    base_zoom_width: 35,
                    width: 224
                },

                "ic-loco-c2": {
                    base_zoom_width: 36,
                    width: 225
                },
                "ic-coach": {
                    base_zoom_width: 36,
                    width: 254
                },
                "ic-loco": {
                    base_zoom_width: 19,
                    width: 126
                },

                "icn-rear": {
                    base_zoom_width: 32,
                    width: 207
                },
                "icn-middle": {
                    base_zoom_width: 32,
                    width: 218
                },
                "icn-front": {
                    base_zoom_width: 32,
                    width: 207
                },

                "ir-coach": {
                    base_zoom_width: 32,
                    width: 223
                }
            };
            var vehicle_detail_icons = {};

            var service_parts = {
                s: {
                    offsets: [-40, -13, 14, 41],
                    vehicles: ['s-bahn-rear', 's-bahn-middle', 's-bahn-middle', 's-bahn-front']
                },
                sbahn_old: {
                    offsets: [-39, -14, 15, 44],
                    vehicles: ['s-bahn_old-rear', 's-bahn_old-middle', 's-bahn_old-middle', 's-bahn_old-front']
                },
                ic: {
                    offsets: [-110, -87, -58, -29, 0, 29, 58, 87],
                    vehicles: ['ic-loco', 'ic-coach', 'ic-coach', 'ic-coach', 'ic-coach', 'ic-coach', 'ic-coach', 'ic-loco-c2']
                },
                icn: {
                    offsets: [-78, -52, -26, 0, 26, 52, 78],
                    vehicles: ['icn-rear', 'icn-middle', 'icn-middle', 'icn-middle', 'icn-middle', 'icn-middle', 'icn-front']
                },
                ir: {
                    offsets: [-93, -67, -41, -15, 11, 37, 63, 84],
                    vehicles: ['ir-coach', 'ir-coach', 'ir-coach', 'ir-coach', 'ir-coach', 'ir-coach', 'ir-coach', 'ic-loco']
                }
            };

            function getVehicleIcon(zoom, type, heading) {
                var key = zoom + '_' + type + '_' + heading;
                if (typeof vehicle_detail_icons[key] === 'undefined') {
                    var original_width = vehicle_detail_config[type].width;
                    var icon_width = vehicle_detail_config[type].base_zoom_width * Math.pow(2, parseInt(zoom - vehicle_detail_base_zoom, 10));

                    var base_url = 'http://static.vasile.ch/simcity/service-vehicle-detail';

                    var icon = {
                        url: base_url + '/' + type + '/' + heading + '.png',
                        size: new google.maps.Size(original_width, original_width),
                        origin: new google.maps.Point(0, 0),
                        scaledSize: new google.maps.Size(icon_width, icon_width),
                        anchor: new google.maps.Point(parseInt(icon_width/2, 10), parseInt(icon_width/2, 10))
                    };
                    vehicle_detail_icons[key] = icon;
                }

                return vehicle_detail_icons[key];
            }

            return {
                iconGet: iconGet,
                getServicePartsConfig: function(key) {
                    if ((typeof service_parts[key]) === 'undefined') {
                        key = 's';
                    }
                    return service_parts[key];
                },
                getVehicleIcon: getVehicleIcon
            };
        })();

        var vehicle_ib = new InfoBox({
            disableAutoPan: true,
            pixelOffset: new google.maps.Size(10, 10),
            vehicle_id: 0,
            closeBoxURL: ''
        });

        var vehicleIDs = [];

        function Vehicle(params) {
            function parseTimes(times) {
                var time_ar = [];

                $.each(times, function(k, time){
                    // 32855 = 9 * 3600 + 7 * 60 + 35
                    if ((typeof time) === 'number') {
                        if (time < (2 * 24 * 3600)) {
                            time += timer.getTSMidnight();
                        }

                        time_ar.push(time);
                        return;
                    }

                    // 09:07:35
                    if (time.match(/^[0-9]{2}:[0-9]{2}:[0-9]{2}$/) !== null) {
                        time = timer.getHMS2TS(time);

                        time_ar.push(time);
                        return;
                    }

                    // 09:07
                    if (time.match(/^[0-9]{2}:[0-9]{2}$/) !== null) {
                        var hms = time + ':00';

                        time = timer.getHMS2TS(hms);

                        time_ar.push(time);
                        return;
                    }
                });

                return time_ar;
            }

            if ((typeof params.trip_id) === 'undefined') {
                this.source             = 'custom';

                this.id                 = params.id;
                this.name               = params.name;
                this.stations           = params.sts;
                this.edges              = params.edges;
                this.depS               = parseTimes(params.deps);
                this.arrS               = parseTimes(params.arrs);
                this.route_icon         = params.type;
                this.service_type       = params.service_type;

                $.each(params.edges, function(k, edges) {
                    if (k === 0) { return; }
                    linesPool.routeAdd(edges);
                });
            } else {
                // GTFS approach
                this.source             = 'gtfs';

                this.id                 = params.trip_id;
                this.name               = params.route_short_name;

                this.service_type       = '';

                this.edges              = [];
                this.shape_id           = params.shape_id;

                var departures = [];
                var arrivals = [];
                var stations = [];
                var shape_percent = [];
                $.each(params.stops, function(k, stop){
                    if (k < (params.stops.length - 1)) {
                        departures.push(stop.departure_time);
                    }

                    if (k > 0) {
                        arrivals.push(stop.arrival_time);
                    }

                    stations.push(stop.stop_id);
                    shape_percent.push(stop.stop_shape_percent);
                });

                this.stations           = stations;
                this.depS               = parseTimes(departures);
                this.arrS               = parseTimes(arrivals);
                this.shape_percent      = shape_percent;

                this.route_icon         = params.route_type;
            }

            var marker = new google.maps.Marker({
                position: new google.maps.LatLng(0, 0),
                map: null,
                speed: null,
                status: 'not on map'
            });

            var typeofvehicle;
            if(this.route_icon == 0) typeofvehicle = "Eurocity";
            else if(this.route_icon == 1) typeofvehicle = "Extrazug";
            else if(this.route_icon == 2) typeofvehicle = "ICE";
            else if(this.route_icon == 3) typeofvehicle = "InterRegio";
            else if(this.route_icon == 4) typeofvehicle = "Intercity";
            else if(this.route_icon == 5) typeofvehicle = "RegioExpress";
            else if(this.route_icon == 6) typeofvehicle = "Regionalzug";
            else if(this.route_icon == 7) typeofvehicle = "Standseilbahn";
            else if(this.route_icon == 8) typeofvehicle = "S-N";
            else if(this.route_icon == 9) typeofvehicle = "TER200";
            else if(this.route_icon == 10) typeofvehicle = "TGV";
            else if(this.route_icon == 11) typeofvehicle = "Zahnradbahn";

            var icon = imagesPool.iconGet(typeofvehicle);

            if (icon !== null) {
                marker.setIcon(icon);
            }

            this.marker = marker;
            this.detail_markers = [];

            // TODO - FIXME .apply
            var that = this;

            google.maps.event.addListener(marker, 'click', function() {
                simulation_panel.displayVehicle(that);
            });

            this.mouseOverMarker = function() {
                if (map.getZoom() < config.getParam('zoom.vehicle_mouseover_min')) {
                    return;
                }

                if (vehicle_ib.get('vehicle_id') === that.id) { return; }
                vehicle_ib.set('vehicle_id', that.id);

                vehicle_ib.close();

                var popup_div = $('#vehicle_popup');
                $('span.vehicle_name', popup_div).text(that.name);

                var route_config = config.getParam('routes')[that.route_icon];
                if (route_config) {
                    $('span.vehicle_name', popup_div).css('background-color', route_config.route_color);
                    $('span.vehicle_name', popup_div).css('color', route_config.route_text_color);
                }

                $('.status', popup_div).html(marker.get('status'));

                vehicle_ib.setContent($('#vehicle_popup_container').html());
                vehicle_ib.open(map, this);
            };
            this.mouseOutMarker = function() {
                vehicle_ib.set('vehicle_id', null);
                vehicle_ib.close();
            };
            google.maps.event.addListener(marker, 'mouseover', this.mouseOverMarker);
            google.maps.event.addListener(marker, 'mouseout', this.mouseOutMarker);

            if (vehicle_detect.match(this.name, this.id)) {
                simulation_panel.displayVehicle(this);
                simulation_panel.followVehicle(this);
            }
        }
        Vehicle.prototype.render = function() {
            // TODO - FIXME .apply
            var that = this;

            function animate() {
                var ts = timer.getTS();

                var vehicle_position = null;
                var route_percent = 0;
                var d_AC = 0;
                var animation_timeout = 1000;

                for (var i=0; i<that.arrS.length; i++) {
                    if (ts < that.arrS[i]) {
                        var station_a = that.stations[i];
                        var station_b = that.stations[i+1];

                        var route_id = (that.source === 'gtfs') ? that.shape_id : that.edges[i+1];
                        var speed = that.marker.get('speed');
                        if (ts > that.depS[i]) {
                            var routeLength = linesPool.lengthGet(route_id);

                            // Vehicle is in motion between two stations
                            if ((speed === 0) || (speed === null)) {
                                var trackLength = routeLength;
                                if (that.source === 'gtfs') {
                                    trackLength = routeLength * (that.shape_percent[i+1] - that.shape_percent[i]) / 100;
                                }

                                var speed = trackLength * 0.001 * 3600 / (that.arrS[i] - that.depS[i]);
                                that.marker.set('speed', parseInt(speed, 10));
                                that.marker.set('status', 'Heading to ' + stationsPool.get(station_b) + '(' + timer.getHM(that.arrS[i]) + ')<br/>Speed: ' + that.marker.get('speed') + ' km/h');
                            }

                            route_percent = (ts - that.depS[i])/(that.arrS[i] - that.depS[i]);
                            if (that.source === 'gtfs') {
                                route_percent = (that.shape_percent[i] + route_percent * (that.shape_percent[i+1] - that.shape_percent[i])) / 100;
                            }

                            d_AC = routeLength * route_percent;
                        } else {
                            // Vehicle is in a station
                            if ((speed !== 0) || (speed === null)) {
                                that.marker.set('status', 'Departing ' + stationsPool.get(station_a) + ' at ' + timer.getHM(that.depS[i]));
                                that.marker.set('speed', 0);
                            }

                            if (that.source === 'gtfs') {
                                route_percent = that.shape_percent[i] / 100;
                            }
                        }

                        var vehicle_position_data = linesPool.positionGet(route_id, route_percent);
                        if (vehicle_position_data === null) {
                            break;
                        }

                        var vehicle_position = vehicle_position_data.position;

                        if (that.marker.get('follow') === 'yes-init') {
                            that.marker.set('follow', 'yes');

                            map.panTo(vehicle_position);
                            if (map.getZoom() < config.getParam('zoom.vehicle_follow')) {
                                map.setZoom(config.getParam('zoom.vehicle_follow'));
                            }
                            //map.setMapTypeId(google.maps.MapTypeId.SATELLITE);

                            map.bindTo('center', that.marker, 'position');
                        }

                        that.updateIcon(vehicle_position_data, d_AC, i);
                        if (map.getZoom() >= 12) {
                            animation_timeout = timer.getRefreshValue();
                        }

                        setTimeout(animate, animation_timeout);
                        break;
                    }
                } // end arrivals loop

                if (vehicle_position === null) {
                    that.marker.setMap(null);
                    delete simulation_vehicles[that.id];
                }
            }

            animate();
        };
        Vehicle.prototype.updateIcon = function(data, d_AC, i) {
            var service_parts = imagesPool.getServicePartsConfig(this.service_type);
            var render_in_detail = data.is_detailed && (service_parts !== null);
            var vehicle_position = data.position;
            this.marker.setPosition(data.position);

            if (render_in_detail) {
                if (this.marker.getMap() !== null) {
                    this.marker.setMap(null);
                }

                if (map_helpers.getExtendedBounds().contains(vehicle_position)) {
                    var that = this;
                    $.each(service_parts.offsets, function(k, offset){
                        if ((typeof that.detail_markers[k]) === 'undefined') {
                            that.detail_markers[k] = new google.maps.Marker({
                                map: null
                            });

                            var marker = that.detail_markers[k];
                            google.maps.event.addListener(marker, 'mouseover', that.mouseOverMarker);
                            google.maps.event.addListener(marker, 'mouseout', that.mouseOutMarker);
                            google.maps.event.addListener(marker, 'click', function(){
                                simulation_panel.displayVehicle(that);
                            });
                        }

                        var marker = that.detail_markers[k];

                        var route = that.edges[i+1];
                        var route_length = linesPool.lengthGet(route);
                        var d_AC_new = d_AC + offset;

                        if ((d_AC + offset) > route_length) {
                            d_AC_new -= route_length;
                            route = that.edges[i+2];
                        }
                        var position_data = linesPool.projectDistanceAlongRoute(route, d_AC_new);

                        if (position_data === null) {
                            marker.setMap(null);
                            return;
                        }

                        var heading = parseInt(position_data.heading, 10);
                        if (heading < 0) {
                            heading += 360;
                        }
                        heading = ('00' + heading).slice(-3);

                        var zoom = map.getZoom();
                        var icon = imagesPool.getVehicleIcon(zoom, service_parts.vehicles[k], heading);
                        if (((typeof marker.getIcon()) === 'undefined') || (marker.getIcon().url !== icon.url) || (marker.get('zoom') !== zoom)) {
                            marker.setIcon(icon);
                            marker.set('zoom', map.getZoom());
                        }

                        marker.setPosition(position_data.position);
                        if (marker.getMap() === null) {
                            marker.setMap(map);
                        }
                    });
                } else {
                    $.each(this.detail_markers, function(k, marker){
                        marker.setMap(null);
                    });
                    this.detail_markers = [];
                }
            } else {
                $.each(this.detail_markers, function(k, marker){
                    marker.setMap(null);
                });
                this.detail_markers = [];

                if (map.getBounds().contains(vehicle_position)) {
                    if (this.marker.getMap() === null) {
                        this.marker.setMap(map);
                    }
                } else {
                    if (this.marker.getMap() !== null) {
                        this.marker.setMap(null);
                    }
                }
            }
        };

        return {
            load: function() {
                var hm = timer.getHM();
                var ymd = timer.getYMD();
                var url = config.getParam('api_paths.trips');
                url = url.replace(/\[hhmm\]/, hm.replace(':', ''));
                url = url.replace(/\[ymd\]/, ymd.replace(':', ''));
                url = url.replace(/\[vtype\]/, 0); // 1 if all except trains, 2 for trains, else all
                // console.log('url '+ url)
                $("#loadingimg").show();
                $.ajax({
                    url: url,
                    dataType: 'json',
                    success: function(vehicles) {
                        console.log(vehicles)
                        $("#loadingimg").hide();
                        $("#disclamer").show();
                        $.each(vehicles, function(index, data) {
                            var vehicle_id = ((typeof data.trip_id) === 'undefined') ? data.id : data.trip_id;

                            if ((typeof simulation_vehicles[vehicle_id]) !== 'undefined') {
                                return;
                            }

                            var v = new Vehicle(data);
                            v.render();

                            simulation_vehicles[vehicle_id] = v;
                        });

                        listener_helpers.notify('vehicles_load');
                    }
                });
            }
        };
    })();

    listener_helpers.subscribe('map_init', function(){
        function loadStations(url) {
            if (url === null) {
                return;
            }

            $.ajax({
                url: url,
                dataType: 'json',
                success: function(geojson) {
                    if (typeof(geojson.features) === 'undefined') {
                        console.log('Malformed GeoJSON. URL: ' + url);
                        return;
                    }

                    stationsPool.addFeatures(geojson.features);
                    vehicle_helpers.load();
                    listener_helpers.subscribe('minute_changed', vehicle_helpers.load);
                },
                error: function(jqXHR, textStatus, errorThrown) {
                    console.log('Error from server ' + textStatus + ' for url: ' + url);
                }
            });
        }

        // GTFS approach
        var url = config.getParam('geojson.gtfs_shapes');
        if (url !== null) {
            $.ajax({
                url: url,
                dataType: 'json',
                async: false,
                success: function(geojson) {
                    if (typeof(geojson.features) === 'undefined') {
                        console.log('Malformed GeoJSON. URL: ' + url);
                    } else {
                        linesPool.loadGeoJSONShapes(geojson.features);
                    }
                },
                error: function(jqXHR, textStatus, errorThrown) {
                    console.log('Error from server ' + textStatus + ' for url: ' + url);
                }
            });
        }
        loadStations(config.getParam('geojson.gtfs_stops'));
/*
        // Custom topology approach
        var url = config.getParam('geojson.topology_edges');
        if (url !== null) {
            $.ajax({
                url: url,
                dataType: 'json',
                async: false,
                success: function(geojson) {
                    if (typeof(geojson.features) === 'undefined') {
                        console.log('Malformed GeoJSON. URL: ' + url);
                    } else {
                        linesPool.loadGeoJSONEdges(geojson.features);
                    }
                },
                error: function(jqXHR, textStatus, errorThrown) {
                    console.log('Error from server ' + textStatus + ' for url: ' + url);
                }
            });
        }
        loadStations(config.getParam('geojson.topology_stations'));
        */
    });

    function ui_init() {
        var view_mode = config.getParam('view_mode');

        var panel_display = (ua_is_mobile === false) && (view_mode !== 'iframe');
        if (panel_display) {
            $('#panel').removeClass('hidden');
        }
/*
        var time_multiply = config.getParam('time_multiply');
        if (time_multiply !== null) {
            $('#time_multiply').val(time_multiply);
        }
        */
    }

    return {
        init: function(){
            config.init();
            ui_init();
            timer.init();
            map_helpers.init();
            simulation_panel.init();
        },
        getMap: function(){
            return map;
        }
    };
})();

$(document).ready(simulation_manager.init);
