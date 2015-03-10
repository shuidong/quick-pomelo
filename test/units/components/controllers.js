'use strict';

var Q = require('q');
var env = require('../../env');
var logger = require('pomelo-logger').getLogger('test', __filename);

var controllers = require('../../../lib/components/controllers');

describe('controllers test', function(){

	it('load controllers', function(cb){
		var app = env.createMockApp('server1', 'area');
		app.load(controllers, {basePath : 'test/mocks/controllers'});

		return Q.fcall(function(){
			return Q.ninvoke(app, 'start');
		})
		.then(function(){
			(!!app.controllers.dummy).should.eql(true);
		})
		.fin(function(){
			return Q.ninvoke(app, 'stop');
		})
		.nodeify(cb);
	});
});
