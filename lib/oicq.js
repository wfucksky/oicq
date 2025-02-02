/**
 * 数据包解析
 * 系统事件处理
 */
"use strict";
module.exports = {
    onlineListener, offlineListener, networkErrorListener,
    packetListener, createClient,
};
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const { Client, STATUS_ONLINE, STATUS_OFFLINE, STATUS_PENDING } = require("./client");
const tea = require("./algo/tea");
const pb = require("./algo/pb");
const jce = require("./algo/jce");
const { timestamp, BUF0, BUF16, NOOP, checkUin } = require("./common");
const push = require("./online-push");
const sysmsg = require("./core/sysmsg");
const { initFL, initGL } = require("./core/friendlist");
const wt = require("./wtlogin/wt");
const { int32ip2str } = require("./service");

/**
 * @this {import("./ref").Client}
 */
function submitDevice() {
    let body = pb.encode({
        1: 0,
        2: 31,
        5: {
            1: this.apk.subid,
            2: this.device.imei,
            3: this.device.guid,
            5: this.device.android_id,
            6: 1,
        }
    });
    this.sendOidb("OidbSvc.0x6de", body).catch(NOOP);
}

/**
 * @this {import("./ref").Client}
 */
function onPushReq(blob, seq) {
    if (blob[0] === 0)
        blob = blob.slice(4);
    const nested = jce.decode(blob);
    const PushResp = jce.encodeStruct([
        null, nested[1], nested[3], nested[1] === 3 ? nested[2] : null
    ]);
    const extra = {
        req_id: seq,
        service: "QQService.ConfigPushSvc.MainServant",
        method: "PushResp",
    };
    const body = jce.encodeWrapper({ PushResp }, extra);
    this.writeUni("ConfigPushSvc.PushResp", body);
    if (nested[1] === 2 && nested[2]) {
        const buf = jce.decodeNested(nested[2])[5][5];
        const decoded = pb.decode(buf)[1281];
        this.storage.sig_session = decoded[1].toBuffer();
        this.storage.session_key = decoded[2].toBuffer();
        for (let v of decoded[3]) {
            if (v[1] === 10) {
                this.storage.port = v[2][0][3];
                this.storage.ip = int32ip2str(v[2][0][2]);
            }
        }
    }
}

/**
 * 新消息通知
 * @this {import("./ref").Client}
 */
function onPushNotify(blob) {
    if (!this.sync_finished) return;
    const nested = jce.decode(blob.slice(15));
    switch (nested[5]) {
    case 33:
    case 141:
    case 166:
    case 167:
    case 208:
    case 529:
        return this.pbGetMsg();
    case 84:
    case 87:
    case 525:
        return sysmsg.getNewGroup.call(this, nested[5]);
    case 187:
        return sysmsg.getNewFriend.call(this);
    }
}

/**
 * 强制下线通知(通常是被另一个相同端末挤掉了)
 */
function onForceOffline(blob) {
    fs.unlink(path.join(this.dir, "token"), NOOP);
    const nested = jce.decode(blob);
    this.emit("internal.kickoff", {
        type: "PushForceOffline",
        info: `[${nested[1]}]${nested[2]}`,
    });
}

/**
 * 强制下线通知(通常是冻结等特殊事件)
 */
function onMSFOffline(blob) {
    fs.unlink(path.join(this.dir, "token"), NOOP);
    const nested = jce.decode(blob);
    // if (parent[3].includes("如非本人操作，则密码可能已泄露"))
    //     return;
    this.emit("internal.kickoff", {
        type: "ReqMSFOffline",
        info: `[${nested[4]}]${nested[3]}`,
    });
}

/**
 * @this {import("./ref").Client}
 */
function kickoffListener(data) {
    this.status = STATUS_PENDING;
    this._stopHeartbeat();
    this.logger.warn(data.info);
    let sub_type;
    if (data.info.includes("如非本人操作")) {
        sub_type = "kickoff";
        if (this.config.kickoff) {
            this.logger.warn("3秒后重新连接..");
            setTimeout(this.login.bind(this), 3000);
        } else {
            this.terminate();
        }
    } else if (data.info.includes("冻结") || data.info.includes("资金管理")) {
        sub_type = "frozen";
        this.terminate();
    } else if (data.info.includes("设备锁")) {
        sub_type = "device";
        this.terminate();
    } else {
        sub_type = "unknown";
        this.logger.warn("3秒后重新连接..");
        setTimeout(this.login.bind(this), 3000);
    }
    this.em("system.offline." + sub_type, { message: data.info });
}

Client.prototype._register = async function () {
    this.logining = true;
    if (!await wt.register.call(this)) {
        return this.emit("internal.network", "register失败。");
    }
    this.status = STATUS_ONLINE;
    this.logining = false;
    if (!this.online_status)
        this.online_status = 11;
    this.setOnlineStatus(this.online_status);
    this._startHeartbeat();
    if (!this.listenerCount("internal.kickoff")) {
        this.once("internal.kickoff", kickoffListener);
    }
    await this.pbGetMsg();
};

Client.prototype._var4 = 0;
Client.prototype._runCircleTask = function () {
    if (this._var4++ > 10) {
        wt.exchangeEMP.call(this);
        if (this.config.platform != 2 && this.config.platform != 3)
            this.setOnlineStatus(this.online_status);
        this._var4 = 0;
    }
    for (let time of this.seq_cache.keys()) {
        if (timestamp() - time >= 60)
            this.seq_cache.delete(time);
        else
            break;
    }
};
Client.prototype._startHeartbeat = function () {
    if (this._heartbeat)
        return;
    this._heartbeat = setInterval(async () => {
        this._runCircleTask();
        if (!await this.pbGetMsg() && this.isOnline()) {
            this.logger.warn("GetMsg timeout!");
            if (!await this.pbGetMsg() && this.isOnline())
                this._socket.destroy();
        }
        wt.heartbeat.call(this);
    }, 30000);
};
Client.prototype._stopHeartbeat = function () {
    clearInterval(this._heartbeat);
    this._heartbeat = null;
};

//----------------------------------------------------------------------------------------------

/**
 * @this {import("./ref").Client}
 */
async function onlineListener() {
    this.sync_finished = false;
    await this._register();
    if (!this.isOnline())
        return;
    this.logger.mark(`Welcome, ${this.nickname} ! 初始化资源...`);
    submitDevice.call(this);
    await Promise.all([
        initFL.call(this),
        initGL.call(this)
    ]);
    this.logger.mark(`加载了${this.fl.size}个好友，${this.gl.size}个群。`);
    this.sync_finished = true;
    this.logger.mark("初始化完毕，开始处理消息。");
    this.pbGetMsg();
    this.em("system.online");
}

/**
 * @this {import("./ref").Client}
 */
function offlineListener() {
    this._stopHeartbeat();
    if (this.status === STATUS_OFFLINE) {
        return this.emit("internal.network", "网络不通畅。");
    } else if (this.status === STATUS_ONLINE) {
        ++this.stat.lost_times;
        this.logining = true;
        setTimeout(() => {
            this._connect(this._register.bind(this));
        }, 50);
    }
    this.status = STATUS_OFFLINE;
}

/**
 * @this {import("./ref").Client}
 * @param {string} message 
 */
function networkErrorListener(message) {
    this.logining = false;
    this.logger.error(message);
    if (this.status !== STATUS_OFFLINE)
        this.terminate();
    if (this.config.reconn_interval >= 1) {
        this.logger.mark(this.config.reconn_interval + "秒后重新连接。");
        setTimeout(this.login.bind(this), this.config.reconn_interval * 1000);
    }
    this.em("system.offline.network", { message });
}

//----------------------------------------------------------------------------------------------

function onQualityTest(blob, seq) {
    this.writeUni("QualityTest.PushList", BUF0, seq);
}
function onSidTicketExpired(blob, seq) {
    this.writeUni("OnlinePush.SidTicketExpired", BUF0, seq);
}
function onPushDomain() {
    // common.log(blob.toString("hex").replace(/(.)(.)/g, '$1$2 '));
}

/**
 * @param {Buffer} buf 
 */
function parseSSO(buf) {
    const seq = buf.readInt32BE(4);
    const retcode = buf.readInt32BE(8);
    if (retcode !== 0) {
        throw new Error("unsuccessful retcode: " + retcode);
    }
    let offset = buf.readUInt32BE(12) + 12;
    let len = buf.readUInt32BE(offset); // length of cmd
    const cmd = String(buf.slice(offset + 4, offset + len));

    if (cmd === "Heartbeat.Alive") {
        return {
            seq, cmd, payload: BUF0
        };
    }

    offset += len;
    len = buf.readUInt32BE(offset); // length of session_id
    offset += len;
    const flag = buf.readInt32BE(offset);
    let payload;
    if (flag === 0) {
        payload = buf.slice(offset + 8);
    } else if (flag === 1) {
        payload = zlib.unzipSync(buf.slice(offset + 8));
    } else if (flag === 8) {
        payload = buf.slice(offset + 4);
    } else
        throw new Error("unknown compressed flag: " + flag);
    return {
        seq, cmd, payload
    };
}

/**
 * @type {{[k: string]: (this: import("./ref").Client, payload: Buffer, seq?: number) => void}}
 */
const events = {
    "OnlinePush.PbPushGroupMsg": push.onGroupMsg,
    "OnlinePush.PbPushDisMsg": push.onDiscussMsg,
    "OnlinePush.ReqPush": push.onOnlinePush,
    "OnlinePush.PbPushTransMsg": push.onOnlinePushTrans,
    "OnlinePush.PbC2CMsgSync": push.onC2CMsgSync,
    "ConfigPushSvc.PushReq": onPushReq,
    "MessageSvc.PushNotify": onPushNotify,
    "MessageSvc.PushForceOffline": onForceOffline,
    "StatSvc.ReqMSFOffline": onMSFOffline,
    "QualityTest.PushList": onQualityTest,
    "OnlinePush.SidTicketExpired": onSidTicketExpired,
    "ConfigPushSvc.PushDomain": onPushDomain,
};
// MessageSvc.RequestPushStatus 其他PC端login
// MessageSvc.PushReaded 其他端末已读
// StatSvc.SvcReqMSFLoginNotify 其他移动端login
// StatSvc.QueryHB

/**
 * @this {import("./ref").Client}
 * @param {Buffer} pkt
 */
function packetListener(pkt) {
    ++this.stat.recv_pkt_cnt;
    try {
        const flag = pkt.readUInt8(4);
        const encrypted = pkt.slice(pkt.readUInt32BE(6) + 6);
        let decrypted;
        switch (flag) {
        case 0:
            decrypted = encrypted;
            break;
        case 1:
            decrypted = tea.decrypt(encrypted, this.sig.d2key);
            break;
        case 2:
            decrypted = tea.decrypt(encrypted, BUF16);
            break;
        default:
            throw new Error("unknown flag:" + flag);
        }
        const sso = parseSSO(decrypted);
        this.logger.trace(`recv:${sso.cmd} seq:${sso.seq}`);
        if (events[sso.cmd])
            events[sso.cmd].call(this, sso.payload, sso.seq);
        else if (this.handlers.has(sso.seq))
            this.handlers.get(sso.seq)(sso.payload);
    } catch (e) {
        this.logger.debug(e.stack);
        this.emit("internal.exception", e);
    }
}

/**
 * @param {number} uin 
 * @param {import("./ref").ConfBot} config 
 * @returns {Client}
 */
function createClient(uin, config = {}) {
    uin = parseInt(uin);
    if (!checkUin(uin))
        throw new Error("Argument uin is not an OICQ account.");
    return new Client(uin, config);
}

module.exports.Client = Client;
