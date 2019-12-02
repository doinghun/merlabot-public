'use strict';

const dialogflow = require('dialogflow');
const config = require('./config');
const express = require('express');
const crypto = require('crypto');
const bodyParser = require('body-parser');
const request = require('request');
const app = express();
const uuid = require('uuid');
const pg = require('pg');
pg.defaults.ssl = true;

const broadcast = require('./routes/broadcast');
const webviews = require('./routes/webviews');

const userService = require('./services/user-service');
const food = require('./food')
const dialogflowService = require('./services/dialogflow-service');
const fbService = require('./services/fb-service');

const passport = require('passport');
const FacebookStrategy = require('passport-facebook').Strategy;
const session = require('express-session');

// Messenger API parameters
if (!config.FB_PAGE_TOKEN) {
	throw new Error('missing FB_PAGE_TOKEN');
}
if (!config.FB_VERIFY_TOKEN) {
	throw new Error('missing FB_VERIFY_TOKEN');
}
if (!config.GOOGLE_PROJECT_ID) {
	throw new Error('missing GOOGLE_PROJECT_ID');
}
if (!config.DF_LANGUAGE_CODE) {
	throw new Error('missing DF_LANGUAGE_CODE');
}
if (!config.GOOGLE_CLIENT_EMAIL) {
	throw new Error('missing GOOGLE_CLIENT_EMAIL');
}
if (!config.GOOGLE_PRIVATE_KEY) {
	throw new Error('missing GOOGLE_PRIVATE_KEY');
}
if (!config.FB_APP_SECRET) {
	throw new Error('missing FB_APP_SECRET');
}
if (!config.SERVER_URL) { //used for ink to static files
	throw new Error('missing SERVER_URL');
}
if (!config.PG_CONFIG) { //pg config
    throw new Error('missing PG_CONFIG');
}
if (!config.FB_APP_ID) { //app id
    throw new Error('missing FB_APP_ID');
}
app.set('port', (process.env.PORT || 5000))

//verify request came from facebook
app.use(bodyParser.json({
	verify: fbService.verifyRequestSignature
}));

//serve static files in the public directory
app.use(express.static('public'));

// Process application/x-www-form-urlencoded
app.use(bodyParser.urlencoded({
	extended: false
}));

// Process application/json
app.use(bodyParser.json());

app.use(session(
    {
        secret: 'keyboard cat',
        resave: true,
        saveUninitilized: true
    }
));


app.use(passport.initialize());
app.use(passport.session());

passport.serializeUser(function(profile, cb) {
    cb(null, profile);
});

passport.deserializeUser(function(profile, cb) {
    cb(null, profile);
});

passport.use(new FacebookStrategy({
        clientID: config.FB_APP_ID,
        clientSecret: config.FB_APP_SECRET,
        callbackURL: config.SERVER_URL + "auth/facebook/callback"
    },
    function(accessToken, refreshToken, profile, cb) {
        process.nextTick(function() {
            return cb(null, profile);
        });
    }
));

app.get('/auth/facebook', passport.authenticate('facebook',{scope:'public_profile'}));


app.get('/auth/facebook/callback',
    passport.authenticate('facebook', { successRedirect : '/broadcast/broadcast', failureRedirect: '/broadcast' }));

app.set('view engine', 'ejs');

const credentials = {
    client_email: config.GOOGLE_CLIENT_EMAIL,
    private_key: config.GOOGLE_PRIVATE_KEY,
};

const sessionClient = new dialogflow.SessionsClient(
	{
		projectId: config.GOOGLE_PROJECT_ID,
		credentials
	}
);


const sessionIds = new Map();
const usersMap = new Map();

// Index route
app.get('/', function (req, res) {
	res.send('Hello world, I am a chat bot')
})

app.use('/broadcast', broadcast);
app.use('/webviews', webviews);



// for Facebook verification
app.get('/webhook/', function (req, res) {
	console.log("request");
	if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.FB_VERIFY_TOKEN) {
		res.status(200).send(req.query['hub.challenge']);
	} else {
		console.error("Failed validation. Make sure the validation tokens match.");
		res.sendStatus(403);
	}
})

/*
 * All callbacks for Messenger are POST-ed. They will be sent to the same
 * webhook. Be sure to subscribe your app to your page to receive callbacks
 * for your page. 
 * https://developers.facebook.com/docs/messenger-platform/product-overview/setup#subscribe_app
 *
 */
app.post('/webhook/', function (req, res) {
	var data = req.body;
	console.log(JSON.stringify(data));

	// Make sure this is a page subscription
	if (data.object == 'page') {
		// Iterate over each entry
		// There may be multiple if batched
		data.entry.forEach(function (pageEntry) {
			var pageID = pageEntry.id;
			var timeOfEvent = pageEntry.time;

            // Secondary Receiver is in control - listen on standby channel
            if (pageEntry.standby) {
                // iterate webhook events from standby channel
                pageEntry.standby.forEach(event => {
                    const psid = event.sender.id;
                    const message = event.message;
                    console.log('message from: ', psid);
                    console.log('message to inbox: ', message);
                });
            }

            // Bot is in control - listen for messages
            if (pageEntry.messaging) {
                // Iterate over each messaging event
                pageEntry.messaging.forEach(function (messagingEvent) {
                    if (messagingEvent.optin) {
                        fbService.receivedAuthentication(messagingEvent);
                    } else if (messagingEvent.message) {
                        receivedMessage(messagingEvent);
                    } else if (messagingEvent.delivery) {
                        fbService.receivedDeliveryConfirmation(messagingEvent);
                    } else if (messagingEvent.postback) {
                        receivedPostback(messagingEvent);
                    } else if (messagingEvent.read) {
                        fbService.receivedMessageRead(messagingEvent);
                    } else if (messagingEvent.account_linking) {
                        fbService.receivedAccountLink(messagingEvent);
                    } else if (messagingEvent.pass_thread_control) {
                        // do something with the metadata: messagingEvent.pass_thread_control.metadata
                    } else {
                        console.log("Webhook received unknown messagingEvent: ", messagingEvent);
                    }
                });
            }
		});

		// Assume all went well.
		// You must send back a 200, within 20 seconds
		res.sendStatus(200);
	}
});


function setSessionAndUser(senderID) {
    if (!sessionIds.has(senderID)) {
        sessionIds.set(senderID, uuid.v1());
    }

    if (!usersMap.has(senderID)) {
        userService.addUser(function(user){
            usersMap.set(senderID, user);
        }, senderID);
    }
}


function receivedMessage(event) {

	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var timeOfMessage = event.timestamp;
	var message = event.message;

    setSessionAndUser(senderID);

	//console.log("Received message for user %d and page %d at %d with message:", senderID, recipientID, timeOfMessage);
	//console.log(JSON.stringify(message));

	var isEcho = message.is_echo;
	var messageId = message.mid;
	var appId = message.app_id;
	var metadata = message.metadata;

	// You may get a text or attachment but not both
	var messageText = message.text;
	var messageAttachments = message.attachments;
	var quickReply = message.quick_reply;

	if (isEcho) {
        fbService.handleEcho(messageId, appId, metadata);
		return;
	} else if (quickReply) {
        handleQuickReply(senderID, quickReply, messageId);
		return;
	}


	if (messageText) {
		//send message to DialogFlow
        dialogflowService.sendTextQueryToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, messageText);
	} else if (messageAttachments) {
        fbService.handleMessageAttachments(messageAttachments, senderID);
	}
}


function handleQuickReply(senderID, quickReply, messageId) {
    var quickReplyPayload = quickReply.payload;
    switch (quickReplyPayload) {
        case 'HOME':
            //recommend menu
            dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, 'FACEBOOK_WELCOME');
            break;

        case 'MENU_RECOMMENDATION':
            //recommend menu
            dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, 'MENU_RECOMMENDATION');
            break;
        
        case 'FOOD_TYPE':
            //Give food type choices
            dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, 'FOOD_TYPE');
            break;
        
        default:
            dialogflowService.sendTextQueryToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, quickReplyPayload);
            break;
    }
}


function handleDialogFlowAction(sender, action, messages, contexts, parameters) {
	switch (action) {
        case "input.welcome":
            fbService.handleMessages(messages, sender);

            fbService.sendTypingOn(sender);

            //small talk

             setTimeout(function() {
                let responseText = "안녕! 나는 싱가폴 인싸 멀라봇이야 🦁. \n내가 어떻게 도와줄까?";

                let replies = [
                    {
                        "content_type": "text",
                        "title": "뭐 먹지?",
                        "payload": "MENU_RECOMMENDATION"
                    }
                ];

                fbService.sendQuickReply(sender, responseText, replies);
            }, 2000);

            break;

        case "input.unknown":
                fbService.handleMessages(messages, sender);
        
                fbService.sendTypingOn(sender);
        
                //ask what user wants to do next
                setTimeout(function() {
                    let responseText = "미안 아직 거기까진 못알아들었어.. 다른거 물어봐!"
        
                    let replies = [
                        {
                            "content_type": "text",
                            "title": "홈으로 가기",
                            "payload": "WELCOME"
                        }
                    ];
        
                    fbService.sendQuickReply(sender, responseText, replies);
                }, 2000);
        
                break;
         
        case "ask-menu-flow":
            fbService.sendGifMessage(sender,"/assets/merlabot-hungry-resized.gif")
            setTimeout(function() {
                    let responseText = "배고프지! 내가 이따 뭐먹을지 정해줄께";
    
                    let replies = [
                        {
                            "content_type": "text",
                            "title": "그래!",
                            "payload": "FOOD_TYPE"
                        }
                    ];
    
                    fbService.sendQuickReply(sender, responseText, replies);
                }, 4000)

            break;
        case "food-choice":
            let userFoodType = parameters.fields['food_type'].stringValue
            let reply = `오~~ ${userFoodType}! 굳 초이스. 잠깐만 기다려봐..`;
            fbService.sendTextMessage(sender,reply);
            fbService.sendTypingOn(sender);
            setTimeout(function() {
                food.readRandomRestaurant(userFoodType, function(title,description, gmapUrl,imageUrl){
                    let elements = [
                        {
                            "title":title,
                            "image_url": imageUrl,
                            "subtitle":description,
                            "default_action": {
                              "type": "web_url",
                              "url": gmapUrl,
                              "webview_height_ratio": "tall",
                            },
                            "buttons":[
                                {
                                    "type":"web_url",
                                    "url": gmapUrl,
                                    "title":"구글 지도 보기"
                                }              
                            ]
                        }
                    ]
                    fbService.sendGenericMessage(sender,elements)
                })
            },2000)

            setTimeout(function() {
                let responseText = "내 추천 어땡?? ㅇㅅㅇ";

                let replies = [
                    {
                        "content_type": "text",
                        "title": "오 👍👍",
                        "payload": "NEXT"
                    },
                    {
                        "content_type": "text",
                        "title": "다른거 추천 해줘!",
                        "payload": "FOOD_TYPE"
                    }
                ];

                fbService.sendQuickReply(sender, responseText, replies);
            }, 4000)

            break;

		default:
			//unhandled action, just send back the text
            fbService.handleMessages(messages, sender);
	}
}


function handleMessages(messages, sender) {
    let timeoutInterval = 1100;
    let previousType ;
    let cardTypes = [];
    let timeout = 0;
    for (var i = 0; i < messages.length; i++) {

        if ( previousType == "card" && (messages[i].message != "card" || i == messages.length - 1)) {
            timeout = (i - 1) * timeoutInterval;
            setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
            cardTypes = [];
            timeout = i * timeoutInterval;
            setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
        } else if ( messages[i].message == "card" && i == messages.length - 1) {
            cardTypes.push(messages[i]);
            timeout = (i - 1) * timeoutInterval;
            setTimeout(handleCardMessages.bind(null, cardTypes, sender), timeout);
            cardTypes = [];
        } else if ( messages[i].message == "card") {
            cardTypes.push(messages[i]);
        } else  {

            timeout = i * timeoutInterval;
            setTimeout(handleMessage.bind(null, messages[i], sender), timeout);
        }

        previousType = messages[i].message;

    }
}

function handleDialogFlowResponse(sender, response) {
    let responseText = response.fulfillmentMessages.fulfillmentText;

    let messages = response.fulfillmentMessages;
    let action = response.action;
    let contexts = response.outputContexts;
    let parameters = response.parameters;

    fbService.sendTypingOff(sender);

    if (fbService.isDefined(action)) {
        handleDialogFlowAction(sender, action, messages, contexts, parameters);
    } else if (fbService.isDefined(messages)) {
        fbService.handleMessages(messages, sender);
	} else if (responseText == '' && !fbService.isDefined(action)) {
		//dialogflow could not evaluate input.
        fbService.sendTextMessage(sender, "I'm not sure what you want. Can you be more specific?");
	} else if (fbService.isDefined(responseText)) {
        fbService.sendTextMessage(sender, responseText);
	}
}


async function resolveAfterXSeconds(x) {
    return new Promise(resolve => {
        setTimeout(() => {
            resolve(x);
        }, x * 1000);
    });
}


async function greetUserText(userId) {
    let user = usersMap.get(userId);
    if (!user) {
        await resolveAfterXSeconds(2);
        user = usersMap.get(userId);
    }

    else if (user) {
         fbService.sendTypingOn(userId);

            //small talk
        dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, userId, 'FACEBOOK_WELCOME');
    }
}

/*
 * Call the Send API. The message data goes in the body. If successful, we'll 
 * get the message id in a response 
 *
 */
function callSendAPI(messageData) {
	request({
		uri: 'https://graph.facebook.com/v3.2/me/messages',
		qs: {
			access_token: config.FB_PAGE_TOKEN
		},
		method: 'POST',
		json: messageData

	}, function (error, response, body) {
		if (!error && response.statusCode == 200) {
			var recipientId = body.recipient_id;
			var messageId = body.message_id;

			if (messageId) {
				console.log("Successfully sent message with id %s to recipient %s",
					messageId, recipientId);
			} else {
				console.log("Successfully called Send API for recipient %s",
					recipientId);
			}
		} else {
			console.error("Failed calling Send API", response.statusCode, response.statusMessage, body.error);
		}
	});
}


/*
 * Postback Event
 *
 * This event is called when a postback is tapped on a Structured Message. 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/postback-received
 * 
 */
function receivedPostback(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var timeOfPostback = event.timestamp;

    setSessionAndUser(senderID);

	// The 'payload' param is a developer-defined field which is set in a postback 
	// button for Structured Messages. 
	var payload = event.postback.payload;

	switch (payload) {
        case 'FACEBOOK_WELCOME':
            greetUserText(senderID);
            break;
        case 'GET_STARTED':
            greetUserText(senderID);
            break;
        case 'FOOD_TYPE':
            dialogflowService.sendEventToDialogFlow(sessionIds, handleDialogFlowResponse, senderID, 'FOOD_TYPE');
        break;
        default:
			//unindentified payload
            fbService.sendTextMessage(senderID, "큭... 아직 거기까진.... ㅜ");
			break;
	}

	console.log("Received postback for user %d and page %d with payload '%s' " +
		"at %d", senderID, recipientID, payload, timeOfPostback);

}



/*
 * Message Read Event
 *
 * This event is called when a previously-sent message has been read.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-read
 * 
 */
function receivedMessageRead(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;

	// All messages before watermark (a timestamp) or sequence have been seen.
	var watermark = event.read.watermark;
	var sequenceNumber = event.read.seq;

	console.log("Received message read event for watermark %d and sequence " +
		"number %d", watermark, sequenceNumber);
}

/*
 * Account Link Event
 *
 * This event is called when the Link Account or UnLink Account action has been
 * tapped.
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/account-linking
 * 
 */
function receivedAccountLink(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;

	var status = event.account_linking.status;
	var authCode = event.account_linking.authorization_code;

	console.log("Received account link event with for user %d with status %s " +
		"and auth code %s ", senderID, status, authCode);
}

/*
 * Delivery Confirmation Event
 *
 * This event is sent to confirm the delivery of a message. Read more about 
 * these fields at https://developers.facebook.com/docs/messenger-platform/webhook-reference/message-delivered
 *
 */
function receivedDeliveryConfirmation(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var delivery = event.delivery;
	var messageIDs = delivery.mids;
	var watermark = delivery.watermark;
	var sequenceNumber = delivery.seq;

	if (messageIDs) {
		messageIDs.forEach(function (messageID) {
			console.log("Received delivery confirmation for message ID: %s",
				messageID);
		});
	}

	console.log("All message before %d were delivered.", watermark);
}

/*
 * Authorization Event
 *
 * The value for 'optin.ref' is defined in the entry point. For the "Send to 
 * Messenger" plugin, it is the 'data-ref' field. Read more at 
 * https://developers.facebook.com/docs/messenger-platform/webhook-reference/authentication
 *
 */
function receivedAuthentication(event) {
	var senderID = event.sender.id;
	var recipientID = event.recipient.id;
	var timeOfAuth = event.timestamp;

	// The 'ref' field is set in the 'Send to Messenger' plugin, in the 'data-ref'
	// The developer can set this to an arbitrary value to associate the 
	// authentication callback with the 'Send to Messenger' click event. This is
	// a way to do account linking when the user clicks the 'Send to Messenger' 
	// plugin.
	var passThroughParam = event.optin.ref;

	console.log("Received authentication for user %d and page %d with pass " +
		"through param '%s' at %d", senderID, recipientID, passThroughParam,
		timeOfAuth);

	// When an authentication is received, we'll send a message back to the sender
	// to let them know it was successful.
	sendTextMessage(senderID, "Authentication successful");
}

/*
 * Verify that the callback came from Facebook. Using the App Secret from 
 * the App Dashboard, we can verify the signature that is sent with each 
 * callback in the x-hub-signature field, located in the header.
 *
 * https://developers.facebook.com/docs/graph-api/webhooks#setup
 *
 */
function verifyRequestSignature(req, res, buf) {
	var signature = req.headers["x-hub-signature"];

	if (!signature) {
		throw new Error('Couldn\'t validate the signature.');
	} else {
		var elements = signature.split('=');
		var method = elements[0];
		var signatureHash = elements[1];

		var expectedHash = crypto.createHmac('sha1', config.FB_APP_SECRET)
			.update(buf)
			.digest('hex');

		if (signatureHash != expectedHash) {
			throw new Error("Couldn't validate the request signature.");
		}
	}
}

function isDefined(obj) {
	if (typeof obj == 'undefined') {
		return false;
	}

	if (!obj) {
		return false;
	}

	return obj != null;
}

// Spin up the server
app.listen(app.get('port'), function () {
	console.log('running on port', app.get('port'))
})
