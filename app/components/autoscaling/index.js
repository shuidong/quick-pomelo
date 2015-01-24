'use strict';

var _ = require('lodash');
var Q = require('q');
var util = require('util');
var assert = require('assert');
var logger = require('pomelo-logger').getLogger('autoscaling', __filename);

var DEFAULT_SCALE_INTERVAL = 3 * 1000; //Interval to trigger scale process
var DEFAULT_REPORT_TIMEOUT = 10 * 1000; //Server heartbeat timeout
var DEFAULT_LOAD_LIMIT = 0.9; //Max load average before auto release areas
var DEFAULT_ASSIGN_LIMIT = 50; //Max areas assigned in one scaling cycle
var DEFAULT_RELEASE_LIMIT = 10; //Max areas released(in one server) in one scaling cycle

var STATE = {
				NONE : 0,
				INITING : 1,
				IDLE : 2,
				RUNNING : 3,
				CLOSING : 4,
				CLOSED : 5,
			};
/*
 *
 * @params opts.app - pomelo app instance
 */
var AutoScaling = function(opts){
	this.state = STATE.NONE;
	this.app = opts.app;

	var config = this.app.get('autoScalingConfig') || {};

	this.scaleIntervalValue = config.scaleInterval || DEFAULT_SCALE_INTERVAL;
	this.reportTimeoutValue = config.reportTimeout || DEFAULT_REPORT_TIMEOUT;
	this.loadLimit = config.loadLimit || DEFAULT_LOAD_LIMIT;
	this.assignLimit = config.assignLimit || DEFAULT_ASSIGN_LIMIT;
	this.releaseLimit = config.releaseLimit || DEFAULT_RELEASE_LIMIT;

	//Online servers: {serverId : load Average}
	this.servers = {};
	this.reportTimeouts = {};
};

var proto = AutoScaling.prototype;

proto.init = function(){
	assert(this.state === STATE.NONE);

	this.state = STATE.INITING;
	this.scaleInterval = setInterval(this.autoScale.bind(this), this.scaleIntervalValue);
	this.state = STATE.IDLE;

	logger.info('autoScaling inited');
};

proto.close = function(){
	assert(this.state === STATE.IDLE);

	this.state = STATE.CLOSING;
	clearInterval(this.scaleInterval);
	this.state = STATE.CLOSED;

	logger.info('autoScaling closed');
};

/*
 * Heart beat report from areaServer
 */
proto.reportServerStatus = function(serverId, loadAve){
	logger.debug('reportServerStatus %s %s', serverId, loadAve);

	if(!this.servers.hasOwnProperty(serverId)){
		logger.info('Area server %s connected', serverId);
	}
	this.servers[serverId] = loadAve;

	clearTimeout(this.reportTimeouts[serverId]);
	var self = this;
	this.reportTimeouts[serverId] = setTimeout(function(){
		delete self.servers[serverId];
		logger.warn('Area server %s disconnected', serverId);
	}, this.reportTimeoutValue);
};

/*
 * An auto scale process will be triggered timely
 *
 */
proto.autoScale = function(){
	if(this.state !== STATE.IDLE){
		logger.warn('state is not idle');
		return;
	}
	if(Object.keys(this.servers).length === 0){
		logger.warn('no server is available');
		return;
	}

	this.state = STATE.RUNNING;

	logger.info('Start autoscale...');
	var self = this;
	return Q.fcall(function(){
		return self.autoReleaseAreas();
	}).then(function(){
		return self.autoAssignAreas();
	}).catch(function(e){
		logger.error(e.stack);
	}).done(function(){
		logger.info('Finish autoscale');
		self.state = STATE.IDLE; //TODO: autoscale running timeout
	});
};

/*
 * Assign areas which area.serverId = null or area.serverId not in this.servers
 */
proto.autoAssignAreas = function(){
	var areaManager = this.app.get('areaManager');
	var self = this;

	return Q.fcall(function(){
		return areaManager.getAreasNotInServers(Object.keys(self.servers), self.assignLimit);
	}).then(function(areas){
		return Q.allSettled(areas.map(function(area){
			return Q.fcall(function(){
				//Area assigned to one server that not online
				if(area._serverId){
					return areaManager.releaseAreaForce(area._id).then(function(){
						logger.debug('force released %s from offline server %s', area._id, area._serverId);
					}).catch(function(e){
						logger.warn(e.stack);
					});
				}
			}).then(function(){
				return self.assignArea(area._id);
			}).catch(function(e){
				logger.warn(e.stack);
			});
		}));
	});
};

/*
 * Release areas in server which load average exceed limit
 */
proto.autoReleaseAreas = function(){
	var areaManager = this.app.get('areaManager');
	var self = this;

	return Q.allSettled(Object.keys(self.servers).map(function(serverId){
		if(self.servers[serverId] <= self.loadLimit){
			return;
		}
		logger.warn('%s load average is too high, releasing areas...', serverId);
		return Q.fcall(function(){
			return areaManager.getAcquiredAreaIds(serverId, self.releaseLimit);
		}).then(function(areaIds){
			return Q.allSettled(areaIds.map(function(areaId){
				return areaManager.quitServer(areaId).then(function(){
					logger.debug('released %s from %s', areaId, serverId);
				}).catch(function(e){
					logger.warn(e.stack);
				});
			}));
		}).catch(function(e){
			logger.warn(e.stack);
		});
	}));
};

proto.assignArea = function(areaId){
	var serverId = this.getLowestLoadServerId();
	var areaManager = this.app.get('areaManager');

	return Q.fcall(function(){
		return areaManager.joinServer(areaId, serverId);
	}).then(function(){
		logger.debug('Assigned %s to %s', areaId, serverId);
	});
};

proto.getLowestLoadServerId = function(){
	if(Object.keys(this.servers).length === 0){
		throw new Error('No server avaliable');
	}
	var self = this;
	return _.min(Object.keys(this.servers), function(item){ return self.servers[item]; });
};

proto.getHighestLoadServerId = function(){
	if(Object.keys(this.servers).length === 0){
		throw new Error('No server avaliable');
	}
	var self = this;
	return _.max(Object.keys(this.servers), function(item){ return self.servers[item]; });
};

module.exports = AutoScaling;
