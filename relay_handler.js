// Copyright (c) 2015 Uber Technologies, Inc.
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
// THE SOFTWARE.

'use strict';

var errors = require('./errors');
var v2 = require('./v2');

RelayHandler.RelayRequest = RelayRequest;

module.exports = RelayHandler;

function RelayHandler(channel, circuits) {
    var self = this;
    self.channel = channel;
    self.circuits = circuits || null;
    self.logger = self.channel.logger;
}

RelayHandler.prototype.type = 'tchannel.relay-handler';

RelayHandler.prototype.handleLazily = function handleLazily(conn, reqFrame) {
    var self = this;

    // TODO: provide a by-service-name config hook?

    var rereq = new LazyRelayInReq(conn, reqFrame);
    var err = rereq.initRead();
    if (err) {
        rereq.onError(err);
        return true;
    }

    rereq.peer = self.channel.peers.choosePeer(null);
    if (!rereq.peer) {
        rereq.sendErrorFrame('Declined', 'no peer available for request');
        self.logger.warn('no relay peer available', rereq.extendLogInfo({}));
        return true;
    }

    if (self.circuits) {
        self.logger.warn('circuit breaking for lazy realying isn\'t implemented', {
            serviceName: self.channel.serviceName
        });
        return false;
    }

    conn.ops.addInReq(rereq);
    rereq.createOutRequest();
    return true;
};

RelayHandler.prototype.handleRequest = function handleRequest(req, buildRes) {
    var self = this;

    if (self.circuits) {
        self._monitorRequest(req, buildRes);
    } else {
        self._handleRequest(req, buildRes);
    }
};

RelayHandler.prototype._monitorRequest = function _monitorRequest(req, buildRes) {
    var self = this;

    // TODO: null-return is error / declined indication... could be clearer
    buildRes = self.circuits.monitorRequest(req, buildRes);
    if (buildRes) {
        self._handleRequest(req, buildRes);
    }
};

RelayHandler.prototype._handleRequest = function _handleRequest(req, buildRes) {
    var self = this;

    // TODO add this back in a performant way ??
    // if (rereq) {
    //     self.logger.error('relay request already exists for incoming request', {
    //         inReqId: req.id,
    //         priorInResId: rereq.inres && rereq.inres.id,
    //         priorOutResId: rereq.outres && rereq.outres.id,
    //         priorOutReqId: rereq.outreq && rereq.outreq.id
    //         // TODO more context, like outreq remote addr
    //     });
    //     buildRes().sendError(
    //         'UnexpectedError', 'request id exists in relay handler'
    //     );
    //     return;
    // }

    req.forwardTrace = true;

    var peer = self.channel.peers.choosePeer(null);
    if (!peer) {
        // TODO: stat
        // TODO: allow for customization of this message so hyperbahn can
        // augment it with things like "at entry node", "at exit node", etc
        buildRes().sendError('Declined', 'no peer available for request');
        self.logger.warn('no relay peer available', req.extendLogInfo({}));
        return;
    }

    var rereq = new RelayRequest(self.channel, peer, req, buildRes);
    rereq.createOutRequest();
};

// TODO: lazy reqs
// - #onTimeout
// - audit #extendLogInfo vs regular reqs

function LazyRelayInReq(conn, reqFrame) {
    var self = this;

    self.start = conn.timers.now();
    self.remoteAddr = conn.remoteName;
    self.conn = conn;
    self.logger = conn.logger;
    self.peer = null;
    self.outreq = null;
    self.reqFrame = reqFrame;
    self.id = self.reqFrame.id;
    self.serviceName = '';
    self.callerName = '';
    self.timeout = 0;
    self.timedOut = false;
    self.alive = true;

    self.boundExtendLogInfo = extendLogInfo;
    self.boundOnIdentified = onIdentified;

    function extendLogInfo(info) {
        return self.extendLogInfo(info);
    }

    function onIdentified(err) {
        if (err) {
            self.onError(err);
        } else {
            self.onIdentified();
        }
    }
}

LazyRelayInReq.prototype.type = 'tchannel.lazy.incoming-request';

LazyRelayInReq.prototype.initRead =
function initRead() {
    var self = this;

    var res = self.reqFrame.bodyRW.lazy.readTTL(self.reqFrame);
    if (res.err) {
        // TODO: wrap? protocol read error?
        return res.err;
    }
    self.timeout = res.value;

    res = self.reqFrame.bodyRW.lazy.readService(self.reqFrame);
    if (res.err) {
        // TODO: wrap? protocol read error?
        return res.err;
    }
    self.serviceName = res.value;

    // TODO: lazy read self.callerName

    return null;
};

LazyRelayInReq.prototype.extendLogInfo =
function extendLogInfo(info) {
    var self = this;

    if (self.outreq) {
        info = self.outreq._extendLogInfo(info);
    }

    info = self._extendLogInfo(info);

    return info;
};

LazyRelayInReq.prototype._extendLogInfo =
function _extendLogInfo(info) {
    var self = this;

    info.requestType = self.type;
    info.inRemoteAddr = self.remoteAddr;
    info.inRequestId = self.id;
    info.serviceName = self.serviceName;

    // TODO: why not full peer.extendLogInfo
    if (self.peer) {
        info.hostPort = self.peer.hostPort;
    }

    return info;
};

LazyRelayInReq.prototype.logError =
function relayRequestlogError(err, codeName) {
    var self = this;
    logError(self.conn.logger, err, codeName, function extendLogInfo(info) {
        return self.extendLogInfo(info);
    });
};

LazyRelayInReq.prototype.checkTimeout =
function checkTimeout() {
    var self = this;
    if (!self.timedOut) {
        var elapsed = self.conn.timers.now() - self.start;
        if (elapsed > self.timeout) {
            self.timedOut = true;
            // TODO: cancel any outreq?
            self.onError(errors.RequestTimeoutError({
                id: self.id,
                start: self.start,
                elapsed: elapsed,
                timeout: self.timeout
            }));
        }
    }
    return self.timedOut;
};

LazyRelayInReq.prototype.createOutRequest =
function createOutRequest() {
    var self = this;

    if (self.outreq) {
        self.conn.logger.warn('relay request already started', self.extendLogInfo({}));
        return;
    }

    self.peer.waitForIdentified(self.boundOnIdentified);
};

LazyRelayInReq.prototype.onIdentified =
function onIdentified(err) {
    var self = this;

    if (err) {
        self.onError(err);
        return;
    }

    var conn = chooseRelayPeerConnection(self.peer);
    if (!conn.remoteName) {
        // we get the problem
        self.logger.warn('onIdentified called on unidentified connection', self.extendLogInfo({}));
    }
    if (conn.closing) {
        // most likely
        self.logger.warn('onIdentified called on closing connection', self.extendLogInfo({}));
    }

    self.outreq = new LazyRelayOutReq(conn, self);

    var ttl = self.updateTTL(self.outreq.start);
    if (!ttl || ttl < 0) {
        // error or timeout, observability handled already by #updateTTL
        return;
    }

    self.outreq.timeout = ttl;
    conn.ops.addOutReq(self.outreq);
    self.handleFrameLazily(self.reqFrame);
    self.reqFrame = null;
};

LazyRelayInReq.prototype.updateTTL =
function updateTTL(now) {
    var self = this;

    var elapsed = now - self.start;
    var timeout = self.timeout - elapsed;
    if (timeout <= 0) {
        self.sendErrorFrame('Timeout', 'relay ttl expired');
        // TODO: log/stat
        return timeout;
    }

    var res = self.reqFrame.bodyRW.lazy.writeTTL(timeout, self.reqFrame);
    if (res.err) {
        // TODO: wrap? protocol write error?
        self.onError(res.err);
        return NaN;
    }

    return timeout;
};

LazyRelayInReq.prototype.onError =
function onError(err) {
    var self = this;

    if (!self.alive) {
        self.logger.warn('dropping error from dead relay request', self.extendLogInfo({
            error: err
        }));
        return;
    }

    self.alive = false;
    var codeName = errors.classify(err) || 'UnexpectedError';
    self.sendErrorFrame(codeName, err.message);
    logError(self.conn.logger, err, codeName, self.boundExtendLogInfo);
    // TODO: stat in some cases, e.g. declined / peer not available
    self.conn.ops.popInReq(self.id, self.extendLogInfo({
        info: 'lazy relay request error',
        relayDirection: 'in'
    }));
};

LazyRelayInReq.prototype.sendErrorFrame =
function sendErrorFrame(codeName, message) {
    var self = this;
    self.conn.sendLazyErrorFrame(self.reqFrame, codeName, message);
};

LazyRelayInReq.prototype.handleFrameLazily =
function handleFrameLazily(frame) {
    // frame.type will be one of:
    // - v2.Types.CallRequest
    // - v2.Types.CallRequestCont
    var self = this;

    if (!self.alive) {
        self.logger.warn('dropping frame from dead relay request', self.extendLogInfo({}));
        return;
    }

    frame.setId(self.outreq.id);
    self.outreq.conn.socket.write(frame.buffer);
    if (frame.bodyRW.lazy.isFrameTerminal(frame)) {
        self.alive = false;
        self.conn.ops.popInReq(self.id, self.extendLogInfo({
            info: 'lazy relay request done',
            relayDirection: 'in'
        }));
    }
};

function LazyRelayOutReq(conn, inreq) {
    var self = this;

    self.start = conn.timers.now();
    self.remoetAddr = conn.remoteName;
    self.conn = conn;
    self.logger = conn.logger;
    self.inreq = inreq;
    self.id = self.conn.nextFrameId();
    self.serviceName = self.inreq.serviceName;
    self.callerName = self.inreq.callerName;
    self.timeout = 0;
    self.timedOut = false;
}

LazyRelayOutReq.prototype.type = 'tchannel.lazy.outgoing-request';

LazyRelayOutReq.prototype.extendLogInfo =
function extendLogInfo(info) {
    var self = this;

    if (self.inreq) {
        info = self.inreq._extendLogInfo(info);
    }

    info = self._extendLogInfo(info);

    return info;
};

LazyRelayOutReq.prototype._extendLogInfo =
function _extendLogInfo(info) {
    var self = this;

    info.requestType = self.type;
    info.outRequestAddr = self.remoteAddr;
    info.outRequestId = self.id;

    return info;
};

LazyRelayOutReq.prototype.logError =
function relayRequestlogError(err, codeName) {
    var self = this;
    logError(self.conn.logger, err, codeName, function extendLogInfo(info) {
        return self.inreq.extendLogInfo(info);
    });
};

LazyRelayOutReq.prototype.checkTimeout =
function checkTimeout() {
    var self = this;
    if (!self.timedOut) {
        var elapsed = self.conn.timers.now() - self.start;
        if (elapsed > self.timeout) {
            self.timedOut = true;
            // TODO: send cancel?
            // TODO: lighter interface that doesn't create an error to send a frame
            self.inreq.onError(errors.RequestTimeoutError({
                id: self.id,
                start: self.start,
                elapsed: elapsed,
                timeout: self.timeout
            }));
        }
    }
    return self.timedOut;
};

LazyRelayOutReq.prototype.handleFrameLazily =
function handleFrameLazily(frame) {
    // frame.type will be one of:
    // - v2.Types.CallResponse
    // - v2.Types.CallResponseCont
    // - v2.Types.ErrorResponse
    var self = this;

    if (frame.type === v2.Types.ErrorResponse) {
        self.logForwardedError(frame);
    }

    frame.setId(self.inreq.id);
    self.inreq.conn.socket.write(frame.buffer);
    if (frame.bodyRW.lazy.isFrameTerminal(frame)) {
        self.conn.ops.popOutReq(self.id, self.extendLogInfo({
            info: 'lazy relay request done',
            relayDirection: 'out'
        }));
    }
};

LazyRelayOutReq.prototype.logForwardedError =
function logForwardedError(errFrame) {
    var self = this;

    var res = errFrame.bodyRW.lazy.readCode(errFrame);
    if (res.err) {
        self.logger.error('failed to read error frame code', self.extendLogInfo({
            error: res.err
        }));
        return;
    }
    var code = res.value;

    res = errFrame.bodyRW.lazy.readMessage(errFrame);
    if (res.err) {
        self.logger.error('failed to read error frame message', self.extendLogInfo({
            error: res.err
        }));
        return;
    }
    var message = res.value;

    // TODO: thinner logErrorFrame that doesn't need to instantiate an error
    // just to log an error frame
    var codeErrorType = v2.ErrorResponse.CodeErrors[code];
    var err = new codeErrorType({
        originalId: errFrame.id,
        message: message
    });
    self.logError(err, errors.classify(err) || 'UnexpectedError');
};

function RelayRequest(channel, peer, inreq, buildRes) {
    var self = this;

    self.channel = channel;
    self.logger = self.channel.logger;
    self.inreq = inreq;
    self.inres = null;
    self.outres = null;
    self.outreq = null;
    self.buildRes = buildRes;
    self.peer = peer;

    self.error = null;

    self.boundOnError = onError;
    self.boundExtendLogInfo = extendLogInfo;
    self.boundOnIdentified = onIdentified;

    function onError(err) {
        self.onError(err);
    }

    function extendLogInfo(info) {
        return self.extendLogInfo(info);
    }

    function onIdentified(err) {
        if (err) {
            self.onError(err);
        } else {
            self.onIdentified();
        }
    }
}

RelayRequest.prototype.createOutRequest = function createOutRequest() {
    var self = this;

    if (self.outreq) {
        self.logger.warn('relay request already started', self.extendLogInfo({}));
        return;
    }

    self.peer.waitForIdentified(self.boundOnIdentified);
};

RelayRequest.prototype.onIdentified = function onIdentified() {
    var self = this;

    var conn = chooseRelayPeerConnection(self.peer);
    if (!conn.remoteName) {
        // we get the problem
        self.logger.error('onIdentified called on no connection identified', {
            hostPort: self.peer.hostPort
        });
    }
    if (conn.closing) {
        // most likely
        self.logger.error('onIdentified called on connection closing', {
            hostPort: self.peer.hostPort
        });
    }

    var elapsed = self.channel.timers.now() - self.inreq.start;
    var timeout = Math.max(self.inreq.timeout - elapsed, 1);
    // TODO use a type for this literal
    self.outreq = self.channel.request({
        peer: self.peer,
        streamed: self.inreq.streamed,
        timeout: timeout,
        parent: self.inreq,
        tracing: self.inreq.tracing,
        checksum: self.inreq.checksum,
        forwardTrace: true,
        serviceName: self.inreq.serviceName,
        headers: self.inreq.headers,
        retryFlags: self.inreq.retryFlags
    });
    self.outreq.responseEvent.on(onResponse);
    self.outreq.errorEvent.on(self.boundOnError);

    self.channel.emitFastStat(self.channel.buildStat(
        'tchannel.relay.latency',
        'timing',
        elapsed,
        {}
    ));

    if (self.outreq.streamed) {
        self.outreq.sendStreams(self.inreq.arg1, self.inreq.arg2, self.inreq.arg3);
    } else {
        self.outreq.send(self.inreq.arg1, self.inreq.arg2, self.inreq.arg3);
    }

    function onResponse(res) {
        self.onResponse(res);
    }
};

RelayRequest.prototype.createOutResponse = function createOutResponse(options) {
    var self = this;
    if (self.outres) {
        self.logger.warn('relay request already responded', self.extendLogInfo({
            error: self.error,
            options: options // TODO: seems like a Bad Idea ™
        }));
        return null;
    }

    // It is possible that the inreq gets reaped with a timeout
    // It is also possible that the out request gets repead with a timeout
    // Both the in & out req try to create an outgoing response
    if (self.inreq.res && self.inreq.res.codeString === 'Timeout') {
        self.logger.debug('relay request already timed out', {
            codeString: self.inreq.res.codeString,
            responseMessage: self.inreq.res.message,
            serviceName: self.outreq && self.outreq.serviceName,
            arg1: self.outreq && String(self.outreq.arg1),
            outRemoteAddr: self.outreq && self.outreq.remoteAddr,
            inRemoteAddr: self.inreq.remoteAddr,
            inSocketRemoteAddr: self.inreq.connection.socketRemoteAddr,
            error: self.error
        });
        return null;
    }

    self.outres = self.buildRes(options);

    return self.outres;
};

RelayRequest.prototype.onResponse = function onResponse(res) {
    var self = this;

    if (self.inres) {
        self.logger.warn('relay request got more than one response callback', {
            // TODO: better context
            remoteAddr: res.remoteAddr,
            id: res.id
        });
        return;
    }
    self.inres = res;

    if (!self.createOutResponse({
        streamed: self.inres.streamed,
        headers: self.inres.headers,
        code: self.inres.code
    })) return;

    if (self.outres.streamed) {
        self.inres.arg2.pipe(self.outres.arg2);
        self.inres.arg3.pipe(self.outres.arg3);
    } else {
        self.outres.send(self.inres.arg2, self.inres.arg3);
    }
};

RelayRequest.prototype.onError = function onError(err) {
    var self = this;

    if (self.error) {
        // TODO: verify
        // remoteAddr: self.inreq.remoteAddr,
        // serviceName: self.inreq.serviceName,
        // endpoint: self.inreq.endpoint,
        // callerName: self.inreq.callerName,
        self.logger.warn('Unexpected double onError', self.inreq.extendLogInfo({
            error: err,
            oldError: self.error
        }));
    }
    self.error = err;

    if (!self.createOutResponse()) return;
    var codeName = errors.classify(err) || 'UnexpectedError';

    self.outres.sendError(codeName, err.message);
    self.logError(err, codeName);
};

RelayRequest.prototype.extendLogInfo = function extendLogInfo(info) {
    var self = this;

    // XXX does inreq give:
    // info.remoteAddr = self.inreq.remoteAddr;
    // info.id = self.inreq.id;
    info.outRemoteAddr = self.outreq && self.outreq.remoteAddr;
    info = self.inreq.extendLogInfo(info);

    return info;
};

RelayRequest.prototype.logError = function relayRequestLogError(err, codeName) {
    var self = this;
    logError(self.logger, err, codeName, self.boundExtendLogInfo);
};

function logError(logger, err, codeName, extendLogInfo) {
    var level = errors.logLevel(err, codeName);

    var info = extendLogInfo({
        error: err,
        isErrorFrame: err.isErrorFrame
    });

    if (err.isErrorFrame) {
        if (level === 'warn') {
            logger.warn('forwarding error frame', info);
        } else if (level === 'info') {
            logger.info('forwarding expected error frame', info);
        }
    } else if (level === 'error') {
        logger.error('unexpected error while forwarding', info);
    } else if (level === 'warn') {
        logger.warn('error while forwarding', info);
    } else if (level === 'info') {
        logger.info('expected error while forwarding', info);
    }
}

function chooseRelayPeerConnection(peer) {
    var conn = null;
    for (var i = 0; i < peer.connections.length; i++) {
        conn = peer.connections[i];
        if (conn.remoteName && !conn.closing) break;
    }
    return conn;
}
