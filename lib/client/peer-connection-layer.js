'use babel';

//require('webrtc-adapter');

const ServerConfig = require('./server-config.js');
const MessageTypes = require('./message-types.js');
// Server port
const SERVER_PORT = ServerConfig.SERVER_PORT;
// Message types
const ASSIGN_PEER_ID = MessageTypes.ASSIGN_PEER_ID;
const ACCEPTED_PEER_ID = MessageTypes.ACCEPTED_PEER_ID;
const SESSION_OFFER = MessageTypes.SESSION_OFFER;
const SESSION_ANSWER = MessageTypes.SESSION_ANSWER;
const NEW_ICE_CANDIDATE = MessageTypes.NEW_ICE_CANDIDATE;
const LOCAL_PEER_ID = MessageTypes.LOCAL_PEER_ID;
const DATA_CHANNEL_MESSAGE = MessageTypes.DATA_CHANNEL_MESSAGE;

//////////////////////////// LOGGING AND EXCEPTIONS ////////////////////////////

/**
 * Log client-side info
 */
function log(text) {
  const time = new Date();
  console.log('[' + time.toLocaleTimeString() + '] CLIENT: ' + text);
}

/**
 * Log client-side errors
 */
function logError(text) {
  const time = new Date();
  console.error('[' + time.toLocaleTimeString() + '] CLIENT: ' + text);
}

function _createErrorMessage(error) {
  return 'Error: ' + error.name + ':' + error.message;
}

/**
 * Assert condition is true and throw error with given message if not
 */
function throwOnConditionFail(condition, message) {
  if (!condition) {
    message = message || 'Assertion failed.';
    if (typeof Error !== 'undefined') {
      throw new Error(message);
    }
    throw message; // Fallback
  }
}

function PeerConnectionCreationException(message) {
  this.message = message || '';
  this.name = 'PeerConnectionCreationException';
}
PeerConnectionCreationException.prototype = Error.prototype;

function AssigningInvalidPeerIdException(message) {
  this.message = message || '';
  this.name = 'AssigningInvalidPeerIdException'
}
AssigningInvalidPeerIdException.prototype = Error.prototype;
////////////////////////////////////////////////////////////////////////////////

class PeerConnectionLayer {
  constructor() {
    // Hostname TODO: Change to proper hostname of server in prod. build
    this.hostname = '127.0.0.1';
    // List of rtcPeerConnection[s] to remote users
    this.rtcPeerConnections = new Map();
    // List of RTCDataChannel[s] to remote peers indexed by username
    this.dataChannels = new Map();
    // Reference to WebSocket connection to server
    this.serverConnection = null;
    // Unique Peer ID for assigned by signalling server
    this.localPeerId;
    // Queues (arrays) for outgoing messages for each RTCDataChannel
    this.sendQueues = new Map();
    // ICE Servers
    this.iceServers = [{urls: 'stun:stun.l.google.com:19302'}];
    // Observers of the peer connection layer (observers will receive messages
    // delivered by the peer connection layer)
    this.observers = [];
    // Used so this module can present a public event-based API
    this.emitter = new Emitter();
  }

  /** Register observer */
  registerObserver(observer) {
    this.observers.push(observer);
  }

  /** To register observers */
  // TODO: Make this the main way to register observers
  onDidEmitMessage(callback) {
    return this.emitter.on('did-emit-message', callback);
  }

  /** WEBSOCKET SERVER FUNCTIONS **/

  /**
   * Generic startup function to be called by higher-level layer.
   */
  fireUp() {
    return new Promise((resolve, reject) => {
      try {
        this.connectToServer();
        resolve(this);
      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Connect to WebSocket server.
   */
  connectToServer() {
    const appProtocol = 'ws';
    const serverUrl = appProtocol + '://' + this.hostname + ':' + SERVER_PORT;
    log('Connecting to server: ' + serverUrl);
    this.serverConnection = new WebSocket(serverUrl, 'json');
    this.serverConnection.onopen = this._handleServerConnectionOpen.bind(this);
    this.serverConnection.onmessage = this._handleMessageFromServer.bind(this);
  }

  /**
   * Send a message to the server
   */
  _sendToServer(message) {
    let msgString = JSON.stringify(message);
    if (this.serverConnection === undefined || this.serverConnection === null) {
      log('Server connection closed.');
    } else {
      this.serverConnection.send(msgString);
    }
  }

  /**
   * Handler that handles the 'open' event of a WebSocket connection. This
   * event fires when a connection to the server is opened.
   */
  _handleServerConnectionOpen(event) {
    log('Server connection open.');
  }

  /**
   * Handler that handles the 'message' event of a WebSocket connection. This
   * event fires when a message is received from the WebSocket server.
   */
  _handleMessageFromServer(event) {
    const msg = JSON.parse(event.data);

    switch (msg.type) {
      // Server has assigned this peer a unique ID amongst all peers that have
      // registered (or will register) with the server
      case ASSIGN_PEER_ID:
        this._acceptPeerId(msg.assignedPeerId);

        const message = {
          type: LOCAL_PEER_ID,
          localPeerId: this.localPeerId,
        };
        log('Notifying observers of peer ID: ' + this.localPeerId);

        this._notifyObservers(message);
        break;
      // Offer from a remote peer to establish a peer-to-peer session.
      case SESSION_OFFER:
        this._handleSessionOffer(msg);
        break;
      // Answer by remote peer to our offer to establish a peer-to-peer session.
      case SESSION_ANSWER:
        this._handleSessionAnswer(msg);
        break;
      // ICE candidate received from remote peer
      case NEW_ICE_CANDIDATE:
        this._handleNewICECandidate(msg);
        break;
      default:
        logError('Unknown message type: ' + msg.type);
        break;
    }
  }

  /** HANDLERS FOR SIGNALLING MESSAGES */

  /**
   * Handle offer to establish data channel
   */
  async _handleSessionOffer(msg) {
    _checkIntendedRecipient(msg);
    // Session description of the connection at the remote peer's end
    const remoteSessionDescription = msg.sessionDescription;

    try {
      const peerConnection =
        await this._createRtcPeerConnection(msg.senderPeerId);
      await peerConnection.setRemoteDescription(remoteSessionDescription);
      const answer = await peerConnection.createAnswer(peerConnection);
      await peerConnection.setLocalDescription(answer);
      const reply = {
        type: SESSION_ANSWER,
        senderPeerId: this.localPeerId,
        targetPeerId: msg.senderPeerId,
        sessionDescription: peerConnection.localDescription,
      };
      this._sendToServer(reply);
    } catch (err) {
      const errMessage = _createErrorMessage(err);
      logError(errMessage);
    }
  }

  /**
   * Handle answer received from callee in response to local peer's offer to
   * establish an RTCDataChannel.
   */
  async _handleSessionAnswer(msg) {
    _checkIntendedRecipient(msg);
    const remoteSessionDescription = msg.sessionDescription;

    const cond = this.rtcPeerConnections.has(msg.senderPeerId);
    let errMessage = 'Unknown remote peer ID: ' + msg.senderPeerId;
    errMessage += 'Cannot accept session description answer.';
    throwOnConditionFail(cond, errMessage);

    const peerConnection = this.rtcPeerConnections.get(msg.senderPeerId);

    try {
      await peerConnection.setRemoteDescription(remoteSessionDescription);
    } catch (err) {
      const errMessage = _createErrorMessage(err);
      logError(errMessage);
    }
  }

  /**
   * Handle ICE candidate received from remote peer. ICE (Interactive
   * Connectivity Establishment) candidates are used to negotitate the
   * establishment of an interactive peer-to-peer connection between two peers.
   */
  async _handleNewICECandidate(msg) {
    // RTCIceCandidate object
    const candidate = msg.candidate;

    const cond = this.rtcPeerConnections.has(msg.senderPeerId);
    let errMessage = 'Unknown remote peer ID: ' + msg.senderPeerId;
    errMessage += 'Cannot accept session description answer.';
    throwOnConditionFail(cond, errMessage);

    const peerConnection = this.rtcPeerConnections.get(msg.senderPeerId);

    try {
      await peerConnection.addIceCandidate(candidate);
    } catch (err) {
      const errMessage = _createErrorMessage(err);
      logError(errMessage);
    }
  }

  /** PEER CONNECTIONS */

  /**
   * Public function to connect to a peer
   */
  connectToPeer(targetPeerId) {
    this._createRtcPeerConnection(targetPeerId);
  }

  /**
   * Create RTCDataChannel to the peer with the specified ID
   */
  _createDataChannel(targetPeerId) {
    let info = `Creating RTCDataChannel from peer ${this.localPeerId} `;
    info += `to peer ${targetPeerId}`;
    log(info);

    let dataChannelName = `dataChannel-${this.localPeerId}-${targetPeerId}`;
    let peerConnection = this.rtcPeerConnections.get(targetPeerId);

    // Check RTCPeerConnection exists
    if (!peerConnection) {
      let info = `Cannot create RTCDataChannel ${dataChannelName} without `;
      info += `RTCPeerConnection from peer ${this.localPeerId} to peer `;
      info += `${targetPeerId}`;
      logError(info);
      return;
    }

    // Create RTCDataChannel
    let dataChannel = peerConnection.createDataChannel(dataChannelName);
    this.dataChannels.set(targetPeerId, dataChannel);

    let statusChangeHandler = (event) => {
      let state = dataChannel.readyState;
      log('RTCDataChannel: ' + dataChannelName + ' state change: ' + state);
    };

    dataChannel.onopen = statusChangeHandler;
    dataChannel.onclose = statusChangeHandler;
    dataChannel.onmessage = this.handleMessageOverDataChannel.bind(this);
  }

  /**
   * Create and RTCPeerConnection to the peer at the given ID.
   */
  _createRtcPeerConnection(targetPeerId) {
    return new Promise((resolve) => {
      const config = {
        iceServers: this.iceServers
      };
      const peerConnection = new RTCPeerConnection(config);
      this.rtcPeerConnections.set(targetPeerId, peerConnection);

      // Setup event handlers for the newly created RTCPeerConnection

      // CONNECTION STATE CHANGES

      // Fires when aggregrate state of connection changes
      peerConnection.onconnectionstatechange = (event) => {
        const connState = peerConnection.connectionState;
        const dataChannel = this.dataChannels.get(targetPeerId);
        log('Connection state: ' + connState);
        if (connState === 'connected' && !dataChannel) {
          this._createDataChannel(targetPeerId);
        }
      }

      // Fires when local ICE agent needs to send a new candidate to remote peer
      peerConnection.onicecandidate = (event) => {
        log('Received ICE candidate from browser')
        // RTCIceCandidate object
        const iceCandidate = event.candidate;

        if (iceCandidate) {
          log('Generated ICE candidate.');
          const msg = {
            type: NEW_ICE_CANDIDATE,
            senderPeerId: this.localPeerId,
            targetPeerId: targetPeerId,
            iceCandidate: iceCandidate
          };
          this._sendToServer(msg);
        } else {
          let infoString = `All ICE candidates sent to peer ${targetPeerId} `;
          infoString += 'via signalling server.';
          log(infoString);
        }
      };

      // Fires when state of the connection's ICE agent changes.
      peerConnection.oniceconnectionstatechange = (event) => {
        log('ICE agent state change: ' + peerConnection.iceConnectionState);

        switch (peerConnection.iceConnectionState) {
          case 'failed':
          case 'disconnected':
          case 'closed':
            // TODO: Close any media streams
            break;
        }
      };

      // Fires when peer connection's signalling state changes (as a result of
      // setting a local or remote description)
      peerConnection.onsignalingstatechange = (event) => {
        log('Signalling state: ' + peerConnection.signalingState);
      };

      // MISCELLANOUS

      // Fires when RTCDataChannel is added to this connection by a remote peer
      peerConnection.ondatachannel = (event) => {
        const dataChannel = event.channel;
        log('Received data channel: ' + dataChannel);

        if (this.dataChannels.has(targetPeerId)) {
          logWarning('Replacing RTCDataChannel to peer: ' + targetPeerId);
        }
        this.dataChannels.set(targetPeerId, dataChannel);

        // Setup event handlers
        let statusChangeHandler = (event) => {
          let state = dataChannel.readyState;
          let dataChannelName = dataChannel.label;
          log(`RTCDataChannel "${dataChannelName}" state change: "${state}"`);
        };

        dataChannel.onopen = statusChangeHandler;
        dataChannel.onclose = statusChangeHandler;
        dataChannel.onmessage = this.handleMessageOverDataChannel.bind(this);
      };

      // Fires when ICE gathering state changes
      peerConnection.onicegatheringstatechange = (event) => {
        log('ICE gathering state: ' + peerConnection.iceGatheringState);
      };

      // Fires when an identity assertion is created, or during the creation of
      // an offer or an answer
      peerConnection.onidentityresult = (event) => {

      };

      // Fires when connection's identity provider encounters an error while
      // generating an identity assertion
      peerConnection.onidpassertionerror = (event) => {

      };

      // Fires when the connection's identity provider encounters an error while
      // validating an identity assertion
      peerConnection.onidpvalidationerror = (event) => {

      };

      // Fires when a change has occurred which requires negotitation
      peerConnection.onnegotationneeded = async (event) => {
        // Negotiation must be carried out as offerrer.

        try {
          log('Negotiation needed. Creating offer.');
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          const msg = {
            type: SESSION_OFFER,
            senderPeerId: this.localPeerId,
            targetPeerId: targetPeerId,
            sessionDescription: peerConnection.localDescription
          };
          this._sendToServer(msg);
        } catch (err) {
          const errMessage = _createErrorMessage(err);
          logError(errMessage);
        }
      };

      // Fires when an identity assertion, received from a peer, has been
      // successfully evaluated.
      peerConnection.onpeeridentity = (event) => {

      };

      // Fires when a MediaStream is removed from this connection
      peerConnection.onremovestream = (event) => {

      };

      // Fires when a track has been added to the connection
      //peerConnection.ontrack = (event) => {

      //};
      resolve(peerConnection)
    });
  }

  handleMessageOverDataChannel(event) {
    // Should be a string (in particular, stringified JSON)
    let data = event.data;
    log('Delivering message: "' + data + '" to all observers.');

    const wrappedMsg = {
      type: DATA_CHANNEL_MESSAGE,
      data: data,
    };
    this._notifyObservers(wrappedMsg);
  }

  sendMessageToPeer(message, targetPeerId) {
    // Update then get a reference to the sendQueue
    this.sendQueues.get(targetPeerId).push(message);
    let sendQueue = this.sendQueues.get(targetPeerId);

    let dataChannel = this.dataChannels.get(targetPeerId);

    switch (dataChannel.readyState) {
      case 'connecting':
        log('Connection not open. Queueud message: ' + message);
        break;
      case 'open':
        log('Sending message: ' + message);
        if (sendQueue.length > 1) {
          log(`Sending total ${sendQueue.length} messages in queue.`);
        }
        sendQueue.forEach(msg => dataChannel.send(message));
        this.sendQueues.set(targetPeerId, []);
        break;
      case 'closing':
        log(`Attempting to send message while channel ${dataChannel.label}` +
            ` is closing`);
        break;
      case 'closed':
        log(`Attempted to send message over closed channel: ` +
            `${dataChannel.label}`);
        break;
      default:
        logError(`Unexpected RTCDataChannel "readyState": ` +
                 `${dataChannel.readyState}. Attempt to send message to ` +
                 `peer: ${targetPeerId} failed.`);
        break;
    }
  }

  broadcastMessage(message) {
    log('Broadcasting message: ' + message);
    for (let targetPeerId in this.dataChannels) {
      this.sendMessageToPeer(message, targetPeerId);
    }
  }

  /** HELPER FUNCTIONS **/

  /**
   * Do some sanity checks on the given `peerId` and if all is well, set it as
   * the (unique) peer ID of this peer (as stored in this PeerConnectionLayer
   * class).
   */
  _acceptPeerId(peerId) {
    if (!(this.localPeerId === undefined || this.localPeerId === null)) {
      logWarning('Assigning new peer ID to peer with ID: ' + this.localPeerId);
    }
    if (peerId === undefined || peerId === null) {
      const errMessage = `Cannot assign peer ID: "${peerId}" to a peer.`;
      throw new AssigningInvalidPeerIdException(errMessage);
    }
    this.localPeerId = peerId;
  }

  /**
   * Notify observers of the given message, which has the given type.
   */
  _notifyObservers(message) {
    for (const observer of this.observers) {
      observer.notify(message);
    }
  }

  _checkIntendedRecipient(msg) {
    const isIntededPeer =
      this.localPeerId !== undefined &&
      this.localPeerId !== null &&
      msg.targetPeerId === this.localPeerId;

    let errMessage = `Message sent to wrong peer. `;
    errMessage += `Local peer ID: "${this.localPeerId}". `;
    errMessage += `Message target peer ID: "${msg.targetPeerId}".`;

    throwOnConditionFail(isIntededPeer, errMessage);
  }
}

module.exports = PeerConnectionLayer;