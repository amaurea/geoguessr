geoguessr = (function () {

var my = {};
my.sv  = new google.maps.StreetViewService();

my.deg  = Math.PI/180;
my.earth_radius = 6371e3;
my.mod = function(a,b) { var c = a%b; return c < 0 ? c+b : c; }

my.pad = function(n, width, z) {
	z = z || '0';
	n = n + '';
	return n.length >= width ? n : new Array(width - n.length + 1).join(z) + n;
}

// coordinate functions. These will be used to support getting the
// coordinates under the mouse. This is only necessary because google
// didn't publish this as part of their api
my.ang2rect = function(ang) {
	ra  = ang[0];
	dec = ang[1];
	var x = Math.cos(dec)*Math.cos(ra);
	var y = Math.cos(dec)*Math.sin(ra);
	var z = Math.sin(dec);
	return [x,y,z];
}
my.rect2ang = function(rect) {
	var x = rect[0]; var y = rect[1]; var z = rect[2];
	var l = (x**2+y**2+z**2)**0.5;
	x /= l; y /= l; z /= l;
	var ra  = Math.atan2(y,x);
	var dec = Math.asin(z);
	return [ra,dec];
}
my.rotx = function(rect, alpha) {
	var ca = Math.cos(alpha);
	var sa = Math.sin(alpha);
	return [rect[0], ca*rect[1]-sa*rect[2], sa*rect[1]+ca*rect[2]];
}
my.roty = function(rect, alpha) {
	var ca = Math.cos(alpha);
	var sa = Math.sin(alpha);
	return [ca*rect[0]+sa*rect[2], rect[1], -sa*rect[0]+ca*rect[2]];
}
my.rotz = function(rect, alpha) {
	var ca = Math.cos(alpha);
	var sa = Math.sin(alpha);
	return [ca*rect[0]-sa*rect[1], sa*rect[0]+ca*rect[1], rect[2]];
}
my.deproject_tan = function(iang, ang0) {
	// iang are coordinates in the flat tangent plane
	// system. In 3d, these coordinates are [1,iang[0],iang[1]]
	// next rotate to coordinates centered on ang0.
	return my.rect2ang(my.rotz(my.roty([1,iang[0],iang[1]],-ang0[1]),ang0[0]));
}
my.project_tan = function(ang, ang0) {
	var rang = my.roty(my.rotz(my.ang2rect(ang),-ang0[0]),ang0[1]);
	return [rang[1]/rang[0], rang[2]/rang[0]];
}

// Given a mouse event and a pano object, return the heading and pitch
// for the mouse location
my.calc_mouse_pov = function(e, pano) {
	// iwidth is the screen's width in tangent plane
	// degrees at zoom 0. It was determined by fitting
	// a model to measurements for small displacements at many
	// zoom levels, and then further refined by testing this
	// function interactively. The current number should give
	// sub-percent errors.
	const iwidth = 227.8;
	var rect = e.target.getBoundingClientRect();
	var w = rect.right - rect.left;
	var h = rect.bottom - rect.top;
	var x = e.clientX - rect.left - w/2;
	var y = -(e.clientY - rect.top - h/2);
	var pov = game.pano.getPov();
	var iheading = iwidth/2**pov.zoom * x/w;
	var ipitch   = iwidth/2**pov.zoom * y/w;
	var ang = my.deproject_tan([iheading*my.deg,ipitch*my.deg],[pov.heading*my.deg,pov.pitch*my.deg]);
	return {heading:ang[0]/my.deg, pitch:ang[1]/my.deg};
}

my.geo_move = function(pos_from, heading, distance) {
	var tmp;
	tmp = my.roty([0,0,1], -distance/my.earth_radius);
	tmp = my.rotz(tmp, -heading*my.deg);
	tmp = my.roty(tmp, (90-pos_from.lat())*my.deg);
	tmp = my.rotz(tmp, pos_from.lng()*my.deg);
	tmp = my.rect2ang(tmp);
	var pos_to = {lng:tmp[0]/my.deg, lat:tmp[1]/my.deg};
	return pos_to;
}

// Returns the index in arr where val must be inserted to maintain
// sorted order. Can be freom 0 to val.length
my.binsearch = function(arr, val) {
	var a = 0;
	var b = arr.length-1;
	while(b > a+1) {
		var c = ((a+b)/2)|0;
		if(arr[c] <= val) a = c;
		else b = c;
	}
	return arr[b] > val ? a : arr.length;
};

// Random number generation. We do this ourselves because we want to
// be able to seed it. Taken from
// https://stackoverflow.com/questions/521295/seeding-the-random-number-generator-in-javascript

my.Alera = function (seed) {
	if(seed === undefined) {seed = +new Date() + Math.random();}
	function Mash() {
		var n = 4022871197;
		return function(r) {
			for(var t, s, u = 0, e = 0.02519603282416938; u < r.length; u++)
				s = r.charCodeAt(u), f = (e * (n += s) - (n*e|0)),
				n = 4294967296 * ((t = f * (e*n|0)) - (t|0)) + (t|0);
			return (n|0) * 2.3283064365386963e-10;
		}
	}
	return function() {
		var m = Mash(), a = m(" "), b = m(" "), c = m(" "), x = 1, y;
		seed = seed.toString(), a -= m(seed), b -= m(seed), c -= m(seed);
		a < 0 && a++, b < 0 && b++, c < 0 && c++;
		return function() {
			var y = x * 2.3283064365386963e-10 + a * 2091639; a = b, b = c;
			return c = y - (x = y|0);
		};
	}();
}

my.LCG = function (seed) {
	function lcg(a) {return a * 48271 % 2147483647}
	seed = seed ? lcg(seed) : lcg(Math.random());
	return function() {return (seed = lcg(seed)) / 2147483648}
}

my.random = my.Alera();
my.srand  = function (seed) { my.random = my.Alera(seed); }

my.prior_uniform = function() {
	var lat = Math.acos(2*my.random()-1)/my.deg - 90;
	var lng = my.random()*360;
	return new google.maps.LatLng({lat:lat,lng:lng});
}

my.prior_box_uniform = function(bounds) {
	// p = int(dec1,dec) sin(dec) / int(dec1,dec2) sin(dec)
	// nom   = cos(dec) -cos(dec1)
	// denom = cos(dec2)-cos(dec1),
	// so dec = acos(p*(cos(dec2)-cos(dec1)) + cos(dec1))
	var a1 = Math.cos((90-bounds[0].lat())*my.deg);
	var a2 = Math.cos((90-bounds[1].lat())*my.deg);
	var w  = bounds[1].lng() - bounds[0].lng();
	var lat = 90-(Math.acos(a1 + my.random()*(a2-a1))/my.deg);
	var lng = bounds[0].lng() + my.random()*w;
	return new google.maps.LatLng({lat:lat, lng:lng});
}

my.prior_poly_uniform = function(poly) {
	// Find the polygon bounding box, and do rejection sampling inside it
	var bounds = my.get_bounds(poly);
	var poly_obj = new google.maps.Polygon({paths: poly});
	while(true) {
		var pos = my.prior_box_uniform(bounds);
		if(google.maps.geometry.poly.containsLocation(pos, poly_obj))
			return pos;
	}
}

// Draw random positions weighted by population density
my.prior_pop = function(popinfo) {
	// Popinfo is lons,lats,dlons,dlats,pop,cum.
	// First select a random cell with population weighting
	var cum_pop = popinfo[5];
	var tot_pop = cum_pop[cum_pop.length-1];
	var targ_pop = my.random()*tot_pop;
	var ind = Math.min(my.binsearch(cum_pop, targ_pop), cum_pop.length-1);
	// Then draw a random location inside that cell. This assumes flat sky,
	// but cells are pretty small
	var lon = popinfo[0][ind] + (my.random()-0.5)*popinfo[2][ind];
	var lat = popinfo[1][ind] + (my.random()-0.5)*popinfo[3][ind];
	var pos = new google.maps.LatLng({lat:lat, lng:lon});
	return pos;
}

// Draw random positions weighted by population density,
// constrained to be within a polygon
my.prior_poly_pop = function(poly, popinfo) {
	var poly_obj = new google.maps.Polygon({paths: poly});
	while(true) {
		var pos = my.prior_pop(popinfo);
		if(google.maps.geometry.poly.containsLocation(pos, poly_obj))
			return pos;
	}
}

my.read_popinfo = async function(url, minpop=0, uniform=false) {
	var response = await fetch(url);
	var data = await response.text();
	var lines = data.split(/\r?\n/);
	var lons = [], lats = [], dlons = [], dlats = [], pops = [], cumpops = [];
	var cumpop = 0;
	for(var i = 0; i < lines.length; i++) {
		var line = lines[i];
		if(line.startsWith("#")) continue;
		var toks = line.trim().split(/ +/);
		if(toks.length < 2) continue;
		var lon  = parseFloat(toks[0]);
		var lat  = parseFloat(toks[1]);
		var dlon = parseFloat(toks[2]);
		var dlat = parseFloat(toks[3]);
		var pop  = parseFloat(toks[4]);
		if(pop < minpop) continue;
		if(uniform) pop = 1;
		cumpop  += pop;
		lons.push(lon);
		lats.push(lat);
		dlons.push(dlon);
		dlats.push(dlat);
		pops.push(pop);
		cumpops.push(cumpop);
	};
	var popinfo = [lons,lats,dlons,dlats,pops,cumpops];
	return popinfo;
}

my.get_bounds = function(points) {
	bounds = new google.maps.LatLngBounds();
	for(var i = 0; i < points.length; i++)
		bounds.extend(points[i]);
	return [bounds.getSouthWest(), bounds.getNorthEast()];
}

my.get_area = function(bounds) {
	var w = bounds[1].lng() - bounds[0].lng();
	var area = w*(Math.sin(bounds[1].lat()*my.deg)-Math.sin(bounds[0].lat()*my.deg))/my.deg;
	return area;
}

my.get_scale = function(points) {
	if(points == null) return Math.PI*my.earth_radius;
	var bounds = my.get_bounds(points);
	var area   = my.get_area(bounds);
	var angrad = Math.sqrt(area);
	var radius = angrad*my.deg*my.earth_radius;
	return radius;
}

my.apply_defaults = function(options, defaults) {
	var res = {};
	if(defaults != null)
		for(key in defaults) res[key] = defaults[key];
	if(options != null)
		for(key in options)  res[key] = options[key];
	return res;
}

my.format_time = function(t) {
	var mins = Math.floor(t/60);
	var secs = Math.floor(t - mins*60);
	return mins + ":" + my.pad(secs,2);
}

var _draw_position_state = {};
my.draw_positions = function(npos, callback, options) {
	var defaults = { 'nper': 10, prior: my.prior_uniform, radius: 100, cont: 0, mindist: 10, spread:false };
	var options  = my.apply_defaults(options, defaults);
	if(!options.cont) _draw_position_state = {
		datas: [], npos:npos, ntry:npos*options.nper, nres:0, options: options, callback: callback, mindist: options.mindist, ncum:0, nmax:1000 };
	else {
		_draw_position_state.nres = 0;
	}
	// Draw npos*nper candidate positions
	for(var i = 0; i < _draw_position_state.ntry; i++) {
		my.sv.getPanorama({
			location: options.prior(),
			radius: options.radius,
			source: options.roadonly ? google.maps.StreetViewSource.OUTDOOR : google.maps.StreetViewSource.DEFAULT,
			preference: options.nearest ? google.maps.StreetViewPreference.NEAREST : google.maps.StreetViewPreference.BEST,
		}, _draw_position_helper);
	}
}

function _draw_position_helper(data, status) {
	var state = _draw_position_state;
	if(status == 'OK') {
		state.datas.push(data);
		console.log([data.location.latLng.lat(), data.location.latLng.lng()]);
	}
	state.nres++;
	state.ncum++;
	if(state.nres == state.ntry) {
		console.log("draw_position " + state.nres + " ntry " + state.ntry + " npos " + state.npos + " ndata " + state.datas.length + " ncum " + state.ncum);
		// Last result has arrived. Did we get enough data? First eliminate
		// duplicates by enforcing a minimum distance. This also sorts the
		// datas.
		var lim = state.ncum < state.nmax ? state.mindist : null;
		state.datas = _draw_position_sorter_pos(state.datas, state.npos, lim, state.options.spread);
		console.log("after prune " + state.datas.length);
		if(state.datas.length >= state.npos) {
			// Order is random at this point. Make it deterministic
			state.callback(state.datas.slice(0,state.npos));
		}
		else {
			// No. Try to get more
			var options = Object.assign({}, state.options);
			options.cont = 1;
			my.draw_positions(state.npos, state.callback, options);
		}
	}
};

my.get_positions = function(points, callback) {
	_draw_position_state = {
		datas: [], npos:points.length, nres:0, callback: callback };
	// Loop up each point
	for(var i = 0; i < points.length; i++)
		my.sv.getPanorama({ location: points[i], radius: 20, preference: google.maps.StreetViewPreference.NEAREST }, _get_positions_helper);
};

function _get_positions_helper(data, status) {
	var state = _draw_position_state;
	if(status == 'OK') state.datas.push(data);
	state.nres++;
	if(state.nres == state.npos) {
		//// Order is random at this point. Make it deterministic
		state.datas = _draw_position_sorter_hash(state.datas);
		state.callback(state.datas.slice(0,state.npos));
	}
};

// "Random" but deterministic sort
function _draw_position_sorter_hash(datas) {
	return datas.sort(function (d1,d2) {
		var pos1 = d1.location.latLng;
		var pos2 = d2.location.latLng;
		var s1 = pos1.lat()+","+pos1.lng();
		var s2 = pos2.lat()+","+pos2.lng();
		var h1 = my.hash(s1);
		var h2 = my.hash(s2);
		return h1 - h2;
	});
};

my.range = function(n) {
	res = [];
	for(var i = 0; i < n; i++) res.push(i);
	return res;
};

my.argsort = function(vals) {
	return my.range(vals.length).sort(function (i1,i2) {
		return vals[i1]-vals[i2]; });
}

// Sort elements such that distance between elements is maximized.
// This function is very inefficient. And the whole draw_pos{,_helper,_sorted}
// stuff is messy and hard to work with.
function _draw_position_sorter_pos(datas, nmax, lim, spread) {
	if(datas.length == 0) return [];
	var res = [datas[0]];
	var left = datas.slice(1);
	while(left.length > 0 && res.length < nmax) {
		var closest_dists = left.map(function (d1) {
			var individual_dists = res.map(function (d2) {
				return google.maps.geometry.spherical.computeDistanceBetween(d1.location.latLng, d2.location.latLng);
			});
			return Math.min.apply(Math, individual_dists);
		});
		// Optionally eliminate too close objects
		var cand_inds = [];
		for(var ind = 0; ind < closest_dists.length; ind++) {
			var dist = closest_dists[ind];
			if(lim == null || dist > lim) cand_inds.push(ind);
		}
		// Optionally prefer most distant matches
		if(spread) {
			var cand_dists  = [];
			for(var i = 0; i < cand_inds.length; i++)
				cand_dists.push(closest_dists[cand_inds[i]]);
			var sorted_inds = my.argsort(cand_dists);
			var sorted_cands= [];
			for(var i = 0; i < sorted_inds.length; i++)
				sorted_cands.push(cand_inds[sorted_inds[i]]);
			cand_inds = sorted_cands;
		}
		// Accept the last element. If spread is on, this will be the
		// one furthest from the others. Otherwise it will be random
		var best_ind = cand_inds[cand_inds.length-1];
		res.push(left[best_ind]);
		left.splice(best_ind, 1);
	}
	return res;
}

my.hash = function (s) {
  var hash = 0, i, chr;
  if (s.length === 0) return hash;
  for (i = 0; i < s.length; i++) {
    chr   = s.charCodeAt(i);
    hash  = ((hash << 5) - hash) + chr;
    hash |= 0; // Convert to 32bit integer
  }
  return hash;
};

my.parse_query_array = function(query, key) {
	var toks = query.split("&");
	for(var i = 0; i < toks.length; i++) {
		var subs = toks[i].split("=");
		if(subs[0] == key)
			return atob(subs[1]).split(",").map(parseFloat);
	}
	return null;
};

my.parse_query_points = function(query, latkey, lngkey) {
	var lats = my.parse_query_array(query, latkey);
	var lngs = my.parse_query_array(query, lngkey);
	if(lats == null || lngs == null) return null;
	var n = Math.min(lats.length, lngs.length);
	var res = [];
	for(var i = 0; i < n; i++)
		res.push(new google.maps.LatLng(lats[i], lngs[i]));
	return res;
};

my.parse_query_str = function(query, key) {
	var toks = query.split("&");
	for(var i = 0; i < toks.length; i++) {
		var subs = toks[i].split("=");
		if(subs[0] == key)
			return subs[1];
	}
	return null;
};

my.get_option_int = function(key, options, query, defval) {
	if(options && key in options) return options[key];
	if(query) {
		var res = my.parse_query_str(query, key);
		return res != null ? parseInt(res) : defval
	}
	return defval;
};

my.get_option_float = function(key, options, query, defval) {
	if(options && key in options) return options[key];
	if(query) {
		var res = my.parse_query_str(query, key);
		return res != null ? parseFloat(res) : defval
	}
	return defval;
};

my.get_option_points = function(key, latkey, lngkey, options, query, defval) {
	if(options && key in options) return options[key];
	if(query) {
		var res = my.parse_query_points(query, latkey, lngkey);
		if(res != null) return res;
	}
	return defval;
};

function add_element(parent, type, id) {
	var elem = document.createElement(type);
	elem.id = id;
	parent.appendChild(elem);
	return elem;
};
function add_element_class(parent, type, cname) {
	var elem = document.createElement(type);
	elem.className = cname;
	parent.appendChild(elem);
	return elem;
};

my.format_summary_query = function(tasks) {
	var lats_true  = btoa(tasks.map(function(task) { return task.pos_true.lat().toFixed(6); }).join(","));
	var lngs_true  = btoa(tasks.map(function(task) { return task.pos_true.lng().toFixed(6); }).join(","));
	var lats_guess = btoa(tasks.map(function(task) { return task.pos_guess.lat().toFixed(6); }).join(","));
	var lngs_guess = btoa(tasks.map(function(task) { return task.pos_guess.lng().toFixed(6); }).join(","));
	var scores     = btoa(tasks.map(function(task) { return task.score.toFixed(4); }).join(","));
	// Add distances moved and time spent too
	var moved = btoa(tasks.map(function(task) { return task.dist_moved.toFixed(0); }).join(","));
	var times = btoa(tasks.map(function(task) { return task.time_spent.toFixed(1); }).join(","));
	return "tlat="+lats_true+"&tlng="+lngs_true+"&glat="+lats_guess+"&glng="+lngs_guess+"&score="+scores+"&moved="+moved+"&times="+times;
};

my.parse_summary_query = function(query) {
	query = unescape(query);
	var toks  = query.split("&");
	var tlats = [], tlngs = [], glats = [], glngs = [], scores = [];
	var moved = [], times = [];
	for(var i = 0; i < toks.length; i++) {
		var subs = toks[i].split("=");
		if     (subs[0] == "tlat") tlats = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "tlng") tlngs = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "glat") glats = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "glng") glngs = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "score") scores = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "moved") moved = atob(subs[1]).split(",").map(parseFloat);
		else if(subs[0] == "times") times = atob(subs[1]).split(",").map(parseFloat);
	}
	var res = [];
	for(var i = 0; i < scores.length; i++) {
		res.push({
			pos_true:  new google.maps.LatLng(tlats[i], tlngs[i]),
			pos_guess: new google.maps.LatLng(glats[i], glngs[i]),
			score: scores[i],
			moved: moved[i],
			time: times[i],
		});
	}
	return res;
};

my.calc_score = function(r, rmax, tol) {
	tol = tol || 0
	var x = Math.max(r-tol,0)/Math.max(rmax-tol,tol);
	return my.score_core(x);
}

// Compute the normalized score given a normalized distance.
// input: x in range [0:inf], but with 1 being the typical max
// output: [0:1]
// Score should be almost none by the time we reach 1 in input
my.score_core = function(x) {
	return Math.exp(-x/0.05);
};

// Construct a new game using the given map panorama and map
my.Game = function(id, options) {
	var game = this;
	var query = (options == null ? null : options.query);
	query = unescape(query);
	var _opts = {};
	_opts.ntask    = my.get_option_int("ntask",    options, query, 5);
	_opts.maxscore = my.get_option_int("maxscore", options, query, 5000);
	_opts.debug    = my.get_option_int("debug",    options, query, 0);
	_opts.bounds   = my.get_option_points("bounds", "lat","lng", options, query, null);
	_opts.roadonly = my.get_option_int("roadonly", options, query, 0);
	_opts.nearest  = my.get_option_int("nearest",  options, query, 1);
	_opts.seed     = my.get_option_int("seed",     options, query, null);
	_opts.points   = my.get_option_points("points", "tlat", "tlng", options, query, null);
	_opts.tol      = my.get_option_float("tol",    options, query, 0);
	_opts.inactive = my.get_option_float("inactive",options,query, 30);

	this.container = document.getElementById(id);
	this.maxscore  = _opts.maxscore;
	this.debug     = _opts.debug;
	this.bounds    = _opts.bounds;
	this.roadonly  = _opts.roadonly;
	this.nearest   = _opts.nearest;
	this.seed      = _opts.seed;
	this.tol       = _opts.tol;
	this.inactive  = _opts.inactive;

	this.time_prev_tick = Date.now();
	this.time_prev_act  = Date.now();

	if(this.seed != null) my.srand(this.seed);

	this.i = 0;
	this.tasks = [];
	for(var i = 0; i < _opts.ntask; i++) {
		this.tasks[i] = {
			score: 0,
			data: null,
			done: false,
			pos_true: null,
			pos_guess: null,
			dist: 0,
			pos_prev: null,
			dist_moved: 0,
			time_spent: 0,
			trigs: [],
		};
	}
	this.scale     = my.get_scale(this.bounds);

	// Insert divs for each element
	this.map_screen    = add_element(this.container,   "div",     "map_screen");
	this.pano_screen   = add_element(this.container,   "div",     "pano_screen");
	this.map_div       = add_element(this.map_screen,  "div",     "map_div");
	this.answer_line   = add_element(this.map_screen,  "div",     "answer_line");
	this.answer_button = add_element(this.answer_line, "button",  "answer_button");
	this.answer_button.innerHTML = "Answer";
	this.pano_button   = add_element(this.map_screen,  "img",     "pano_button");
	this.pano_button.src = "camera_icon.png";
	this.pano_div      = add_element(this.pano_screen, "div",     "pano_div");
	this.map_button    = add_element(this.pano_screen, "img",     "map_button");
	this.map_button.src = "map_icon.png";
	this.reload_button     = add_element(this.pano_screen, "img",     "reload_button");
	this.reload_button.src = "reload_icon.svg"

	this.status_line   = add_element(this.container,   "div",     "status_line");
	this.score_text    = add_element(this.status_line, "div",     "score_text");
	this.score_sub     = add_element(this.status_line, "div",     "score_sub");
	this.time_text     = add_element(this.container,   "div",     "time_text");
	this.tot_time_text = add_element(this.container,   "div",     "tot_time_text");
	this.moved_text    = add_element(this.container,   "div",     "moved_text");
	this.task_wrapper  = add_element(this.map_screen,  "div",     "task_wrapper");
	this.task_summary  = add_element(this.task_wrapper,"div",     "task_summary");
	// The trigonometry widget will be in both screens, so add it to the
	// top container
	this.trigwidget = add_element(this.container,  "div", "trigwidget");
	// The main trig button
	this.trigbutton = add_element(this.trigwidget, "div", "trigbutton");
	this.trigbutton.classList.add("symbol");
	var tmp = document.createElement("img");
	tmp.src = "triangulation_symbol.svg"
	this.trigbutton.appendChild(tmp);
	// The menu that pops up when you click it
	this.trigmenu= add_element_class(this.trigwidget, "ul", "menu");
	this.trigadd = add_element(this.trigmenu, "li", "trigadd");
	// The submenu that pops up when you click on each of these
	// Will need to be dynamically repopulated, so only outer part here
	this.trigaddbutton = add_element_class(this.trigadd, "div", "symbol");
	var tmp = document.createElement("img");
	tmp.src = "target_symbol.svg";
	this.trigaddbutton.appendChild(tmp);
	this.trigaddmenu = add_element_class(this.trigadd, "ul", "submenu");
	this.trigaddbutton.addEventListener("click", function(e) {
		this.trigaddmenu.style.display = "block";
		this.trigdelmenu.style.display = "none";
	}.bind(this));
	// And the same for trigdel
	this.trigdel = add_element(this.trigmenu, "li", "trigdel");
	this.trigdelbutton = add_element_class(this.trigdel, "div", "symbol");
	var tmp = document.createElement("img");
	tmp.src = "cross_symbol.svg";
	this.trigdelbutton.appendChild(tmp);
	this.trigdelmenu = add_element_class(this.trigdel, "ul", "submenu");
	this.trigdelbutton.addEventListener("click", function(e) {
		this.trigaddmenu.style.display = "none";
		this.trigdelmenu.style.display = "block";
		// Disable any pending registering
		this.trig_set_registering(false);
	}.bind(this));
	// The current trigonometry mode
	this.trigindex = 0;
	this.trig_registering = false;
	this.trig_colors = ["red", "green", "blue", "magenta", "orange", "cyan"];
	this.mapdrawings = [];

	this.pano = new google.maps.StreetViewPanorama(this.pano_div, {
		addressControl: false,
		linksControl: false,
		zoomControl: true,
		panControl: true,
		zoomControlOptions: { position: google.maps.ControlPosition.TOP_LEFT },
		panControlOptions:  { position: google.maps.ControlPosition.TOP_RIGHT },
		showRoadLabels: this.debug ? true : false,
	});
	this.map  = new google.maps.Map(this.map_div, {
		zoom: 1,
		clickableIcons: false,
		streetViewControl: false,
		gestureHandling: 'greedy',
		draggableCursor: 'crosshair',
		draggingCursor: 'crosshair',
		mapTypeId: 'hybrid',
		zoomControlOptions: { position: google.maps.ControlPosition.TOP_LEFT },
	});
	this.marker_guess   = new google.maps.Marker({position: {lat:0, lng:0}, visible: false, map: this.map,
		icon: "markers/marker_red_dot.svg"});
	this.marker_true    = new google.maps.Marker({ position: {lat:0, lng:0}, visible: false, map: this.map,
		icon: "markers/marker_green_dot.svg"});

	// Draw bounding polygon if we have one
	if(this.bounds != null)
		this.poly = new google.maps.Polygon({
			path: this.bounds,
			strokeColor: "red",
			strokeOpacity: 1.0,
			strokeWeight: 3,
			fillColor: "red",
			fillOpacity: 0.0,
			editable: false,
			clickable: false,
			map: this.map,
		});

	this.set_task = function (i) {
		this.i = i;
		var ieff = my.mod(i, this.tasks.length);
		this.pano.setPano(this.tasks[ieff].data.location.pano);
		if(this.bounds == null) {
			this.map.setCenter({lat:0,lng:0});
			this.map.setZoom(1);
		} else {
			var bounds = new google.maps.LatLngBounds();
			for(var i = 0; i < this.bounds.length; i++)
				bounds.extend(this.bounds[i]);
			this.map.fitBounds(bounds);
		}
		this.update_status();
		this.update_markers();
		this.update_dist_display();
		this.update_time_display();
		this.trig_menu_update();
		this.trig_map_update();
		this.trig_set_registering(false);
	};

	// Handle panorama motion
	this.pano.addListener("position_changed", function () {
		var pos  = this.getPosition();
		var task = game.get_task();
		var dist = google.maps.geometry.spherical.computeDistanceBetween(task.pos_prev, pos);
		task.pos_prev = pos;
		task.dist_moved += dist;
		game.update_dist_display();
		game.update_interact_time();
	});

	this.update_interact_time = function () { game.time_prev_act = Date.now(); }
	this.pano.addListener("position_changed", this.update_interact_time);
	this.pano.addListener("pov_changed",      this.update_interact_time);
	this.pano.addListener("pano_changed",     this.update_interact_time);
	this.map.addListener("mousemove",         this.update_interact_time);
	this.map.addListener("zoom_changed",      this.update_interact_time);
	this.timer_interval = window.setInterval(function () {
		// Get how long has elapsed, and update our last tick time. time_prev_tick might
		// not be necessary if setInterval is reliable, which I think it is.
		var t  = Date.now();
		var dt = t - game.time_prev_tick;
		game.time_prev_tick = t;
		// Update our time spent unless we're inactive
		if(t - game.time_prev_act > game.inactive*1000) return;
		var task = game.get_task();
		task.time_spent += dt/1e3;
		//console.log(task.time_spent);
		// And update the screen
		game.update_time_display();
	}, 1000);

	this.update_status = function () {
		var total_score = 0, ndone = 0;
		for(var i = 0; i < this.tasks.length; i++) {
			total_score += this.tasks[i].score;
			ndone += this.tasks[i].done;
		}
		this.score_text.innerHTML = "Task " + (my.mod(this.i, this.tasks.length)+1) + "/" + this.tasks.length + "  Total score " + total_score.toFixed(0);
		var scores = [];
		for(var i = 0; i < this.tasks.length; i++) {
			if(!this.tasks[i].done) break;
			scores.push(this.tasks[i].score.toFixed(0));
		}
		this.score_sub.innerHTML = scores.join("  &sdot;  ");
	};

	this.update_markers = function () {
		var task = this.get_task();
		// Update guess marker
		if(task.pos_guess != null) {
			this.marker_guess.setPosition(task.pos_guess);
			this.marker_guess.setVisible(true);
		} else this.marker_guess.setVisible(false);
		// Update true answer
		if(task.done) {
			this.marker_true.setPosition(task.pos_true);
			this.marker_true.setVisible(true);
		} else this.marker_true.setVisible(false);
		// update answer button
		this.answer_button.innerHTML = task.done ? (this.i >= this.tasks.length-1 ? "Summary" : "Next") : "Answer";
		if(task.pos_guess == null)
			this.answer_button.style.background = "gray";
		else
			this.answer_button.style.background = "green";
		// Update task summary
		this.task_wrapper.style.display = task.done ? "flex" : "none";
		if(task.done)
			this.task_summary.innerHTML = Math.floor(task.dist).toLocaleString() + " m<br>" + task.score.toFixed(0) + " points";
	};

	this.update_dist_display = function () {
		var task = game.get_task();
		game.moved_text.innerHTML = Math.floor(task.dist_moved).toLocaleString() + " m";
	};

	this.update_time_display = function () {
		// Time in current task
		var t = game.get_task().time_spent;
		// Total time
		var t_tot = 0;
		for(var i = 0; i < game.tasks.length; i++)
			t_tot += game.tasks[i].time_spent;
		game.time_text.innerHTML     = my.format_time(t);
		game.tot_time_text.innerHTML = my.format_time(t_tot);
	};

	this.set_mode = function (mode) {
		this.mode = mode;
		if(mode == "map") {
			this.map_screen.style.display  = 'inherit';
			this.pano_screen.style.display = 'none';
		}
		else if(mode == "pano") {
			this.map_screen.style.display = 'none';
			this.pano_screen.style.display = 'inherit';
		}
		google.maps.event.trigger(this.map, 'resize');
		google.maps.event.trigger(this.pano, 'resize');
	};

	this.handle_answer_button = function () {
		var task = this.get_task();
		if(!task.done) {
			// Not done, so accept an answer
			if(task.pos_guess != null)
				this.give_answer();
		} else {
			if(this.i < this.tasks.length-1) {
				// More tasks left, so go to next one
				this.set_task(this.i+1);
				this.set_mode("pano");
			} else {
				// Done with everything. Go so summary
				this.summarize();
			}
		}
	};

	this.give_answer = function () {
		var task = this.get_task();
		var dist = google.maps.geometry.spherical.computeDistanceBetween(task.pos_guess, task.pos_true);
		task.dist  = dist;
		task.score = this.maxscore*my.calc_score(dist, this.scale, this.tol);
		task.done  = true;
		this.update_markers();
		this.update_status();
		this.fit_guess_answer();
		this.answer_button.blur();
	};

	this.fit_guess_answer = function () {
		var task = this.get_task();
		var bounds = new google.maps.LatLngBounds();
		bounds.extend(task.pos_true);
		bounds.extend(task.pos_guess);
		this.map.fitBounds(bounds);
	};

	// Get our panorama positions. There are two cases.
	// If we have a set of points to use, try to use those directly
	// Otherwise, we draw them randomly
	var import_datas = function(datas) {
		for(var i = 0; i < this.tasks.length; i++) {
			this.tasks[i].data     = datas[i];
			this.tasks[i].pos_true = datas[i].location.latLng;
			this.tasks[i].pos_prev = this.tasks[i].pos_true;
		}
		this.set_task(0);
	}.bind(this);

	
	this.map.addListener("click", function(e) {
		if(this.trig_registering) {
			var trigs = this.get_task().trigs;
			trigs[this.trigindex].pos = e.latLng;
			this.trig_map_update();
			this.trig_set_registering(false);
			return false;
		} else {
			var task = this.get_task();
			if(task.done) return;
			task.pos_guess = e.latLng;
			this.update_markers();
		}
	}.bind(this));
	this.pano_div.addEventListener("click", function(e) {
		if(this.trig_registering) {
			var trigs = this.get_task().trigs;
			var pov   = my.calc_mouse_pov(e, this.pano);
			trigs[this.trigindex].heading = pov.heading;
			trigs[this.trigindex].pitch   = pov.pitch;
			this.trig_map_update();
			this.trig_set_registering(false);
		}
	}.bind(this));

	// Trigonometry mode stuff
	// Main menu
	this.trigbutton.addEventListener("click", function(e) {
		this.trig_menu_toggle();
	}.bind(this));
	this.trig_set_registering = function(onoff) {
		if(onoff) {
			this.trig_registering = true;
			this.pano.setOptions({clickToGo:false});
			// Mark current register target as active
			var tmp = document.querySelector("#trigadd .submenu :nth-child("+(this.trigindex+1)+") .symbol");
			tmp.classList.add("active");
		} else {
			this.trig_registering = false;
			setTimeout(this.pano.setOptions.bind(this.pano), 500, {clickToGo:true});
			// Remove register highlighting
			document.querySelectorAll("#trigadd .submenu .symbol").forEach(elem => elem.classList.remove("active"));
		}
	}
	this.trig_menu_show = function() { this.trigmenu.style.display = "block"; }
	this.trig_menu_hide = function() {
		this.trigmenu.style.display = "none";
		// Disable any registering we may have going on
		this.trig_set_registering(false);
	}
	this.trig_menu_toggle = function() {
		if(this.trigmenu.style.display == "block") this.trig_menu_hide();
		else this.trig_menu_show();
	}
	// Update the trigwidget submenus based on what
	// tripoints have been created
	this.trig_menu_update = function() {
		var task  = this.get_task();
		var ntrig = task.trigs.length;
		// Add menu
		this.trigaddmenu.innerHTML = "";
		for(let i = 0; i < ntrig; i++) {
			var row  = document.createElement("li");
			var elem = document.createElement("div");
			elem.classList.add("symbol");
			elem.classList.add("num");
			elem.classList.add("trigitem"+(task.trigs[i].color+1));
			elem.innerHTML = (i+1);
			elem.addEventListener("click", function (e) {
				this.trig_register(i);
			}.bind(this));
			row.appendChild(elem);
			this.trigaddmenu.appendChild(row);
		}
		var row  = document.createElement("li");
		var elem = document.createElement("div");
		elem.classList.add("symbol");
		elem.classList.add("plus");
		elem.innerHTML = "+";
		elem.addEventListener("click", function (e) {
			var col = this.trig_find_free_color();
			this.get_task().trigs.push({
				heading:null,
				pitch:null,
				pos:null,
				color:col,
				pointelem:null,
				lineelem:null,
				panoelem:null,
			});
			this.trig_register(ntrig);
		}.bind(this));
		row.appendChild(elem);
		this.trigaddmenu.appendChild(row);
		// Del menu
		this.trigdelmenu.innerHTML = "";
		for(let i = 0; i < ntrig; i++) {
			var row  = document.createElement("li");
			var elem = document.createElement("div");
			elem.classList.add("symbol");
			elem.classList.add("num");
			elem.classList.add("trigitem"+(task.trigs[i].color+1));
			elem.innerHTML = (i+1);
			elem.addEventListener("click", function (e) {
				this.trig_delete(i);
			}.bind(this));
			row.appendChild(elem);
			this.trigdelmenu.appendChild(row);
		}
	}
	this.trig_find_free_color = function() {
		var trigs = this.get_task().trigs;
		// First get the set of all active colors
		var cols = [];
		for(var i = 0; i < trigs.length; i++)
			cols.push(trigs[i].color);
		cols.sort(function(a,b){return a-b});
		var i;
		for(i = 0; i < cols.length; i++) {
			if(cols[i] > i) break;
		}
		return i;
	}
	this.trig_get_color = function(i) {
		if(i >= 0 && i < this.trig_colors.length)
			return this.trig_colors[i];
		else
			return "white";
	}
	this.trig_delete = function(i) {
		var trigs = this.get_task().trigs;
		if(i >= 0 && i < trigs.length)
			trigs.splice(i, 1);
		this.trig_menu_update();
		this.trig_map_update();
	}
	this.trig_register = function(i) {
		this.trigindex = i;
		this.trig_menu_update();
		this.trig_set_registering(true);
	}
	this.trig_map_clear = function() {
		for(var i = 0; i < this.mapdrawings.length; i++)
			this.mapdrawings[i].setMap(null);
		this.mapdrawings = [];
	}
	this.trig_map_update = function() {
		this.trig_map_clear();
		var trigs = this.get_task().trigs;
		for(var i = 0; i < trigs.length; i++) {
			var trig = trigs[i];
			// Then build the new ones
			if(trig.pos) {
				trig.pointelem = new google.maps.Marker({
					position: trig.pos,
					icon: {
						path: google.maps.SymbolPath.CIRCLE,
						fillColor: this.trig_get_color(trig.color),
						strokeColor: this.trig_get_color(trig.color),
						scale: 4,
					},
				});
				trig.pointelem.setMap(this.map);
				this.mapdrawings.push(trig.pointelem);
			}
			if(trig.pos && trig.heading) {
				trig.lineelem = new google.maps.Polyline({
					path:[trig.pos, my.geo_move(trig.pos, trig.heading+180, 100e3)],
					geodesic: true,
					strokeColor: this.trig_get_color(trig.color),
					strokeWeight: 2,
				});
				trig.lineelem.setMap(this.map);
				this.mapdrawings.push(trig.lineelem);
			}
			if(trig.heading) {
				// Compute virtual position so we can display a marker
				// there. This has some limitations: We must make up
				// not too far away distance, and street view markers do not
				// support elevation. So the marker will be at the horizon.
				var offset_pos = my.geo_move(this.get_task().pos_true, trig.heading, 100);
				trig.panoelem = new google.maps.Marker({
					position: offset_pos,
					icon: {
						path: google.maps.SymbolPath.CIRCLE,
						fillColor: this.trig_get_color(trig.color),
						strokeColor: this.trig_get_color(trig.color),
						scale: 15,
					},
				});
				trig.panoelem.setMap(this.pano);
				this.mapdrawings.push(trig.panoelem);
			}
		}
	}

	this.get_task = function () {
		return this.tasks[my.mod(this.i,this.tasks.length)];
	}

	this.summarize = function () {
		// Form the URL for the summary page. This simply needs the
		// latLng of the answer and guess and score for each
		var url = "summary.html?" + my.format_summary_query(this.tasks);
		window.location = url;
	}

	this.map_button.addEventListener("click", function(e) { this.set_mode("map"); }.bind(this));
	this.pano_button.addEventListener("click", function(e) { this.set_mode("pano"); }.bind(this));
	this.answer_button.addEventListener("click", this.handle_answer_button.bind(this));
	this.reload_button.addEventListener("click", function(e) { this.set_task(this.i); }.bind(this));

	// Set up prior
	if(this.bounds == null) prior = my.prior_uniform;
	else prior = my.prior_poly_uniform.bind(null, this.bounds);

	if(_opts.points == null) {
		// Draw points randomly
		my.draw_positions(this.tasks.length, import_datas, {prior: prior, roadonly: this.roadonly, nearest: this.nearest});
	} else {
		my.get_positions(_opts.points, import_datas);
	}

	this.trig_menu_update();
};

my.Summary = function(id, tasks) {
	this.tasks = tasks;

	this.container     = document.getElementById(id);
	this.summary_map   = add_element(this.container,   "div", "summary_map");
	this.summary_info  = add_element(this.container,   "div", "summary_info");

	// Build the summary info table
	var infostr = "<table><tr><th></th><th>Distance</th><th>Moved</th><th>Time</th><th>Score</th></tr>";
	var total_score = 0;
	for(var i = 0; i < tasks.length; i++) {
		var task = this.tasks[i];
		var dist = google.maps.geometry.spherical.computeDistanceBetween(task.pos_guess, task.pos_true);
		infostr += "<tr><th>" + (i+1) + "</th><td>" + Math.floor(dist).toLocaleString() + " m</td><td>" + Math.floor(task.moved).toLocaleString() + " m</td><td>" + my.format_time(task.time) + "</td><td>" + task.score.toFixed(0) + " pt</td></tr>";
		total_score += task.score;
	}
	var infostr = "<h1>Final score " + total_score.toFixed(0) + "</h1>" + infostr + "</table>";
	this.summary_info.innerHTML = infostr;

	this.map           = new google.maps.Map(this.summary_map, {
		center: {lat:0,lng:0},
		zoom: 1,
		clickableIcons: false,
		gestureHandling: 'greedy',
		mapTypeId: 'hybrid',
		zoomControlOptions: { position: google.maps.ControlPosition.TOP_LEFT },
	});

	// Add all the markers
	for(var i = 0; i < this.tasks.length; i++) {
		var task = this.tasks[i];
		task.marker_guess   = new google.maps.Marker({position: task.pos_guess, map: this.map,
			icon: "markers/marker_red_" + my.pad(i+1,2) + ".svg"});
		task.marker_true    = new google.maps.Marker({position: task.pos_true,  map: this.map,
			icon: "markers/marker_green_" + my.pad(i+1,2) + ".svg"});
		// Draw a geodesic connecting the guesses
		task.line = new google.maps.Polyline({
			path: [task.pos_true, task.pos_guess],
			strokeColor: "black",
			geodesic: true,
			map: this.map,
		});
	}

	// Zoom to contain the markers
	var bounds = new google.maps.LatLngBounds();
	for(var i = 0; i < tasks.length; i++) {
		bounds.extend(tasks[i].pos_guess);
		bounds.extend(tasks[i].pos_true);
	}
	this.map.fitBounds(bounds);

};

return my;
}());
