const Botkit = require('botkit');
const apiai = require('apiai');
const uuid = require('node-uuid');
const http = require('http');
var axios = require('axios');
var GitHub = require('github-api');
const Entities = require('html-entities').XmlEntities;
const decoder = new Entities();
const apiAiAccessToken = process.env.accesstoken;
const slackBotKey = process.env.slackkey;
var github = new GitHub({ token: process.env.githubtoken});
const devConfig = process.env.DEVELOPMENT_CONFIG == 'true';
const npmKeyword = require('npm-keyword');
const apiaiOptions = {};

if (devConfig) {
  apiaiOptions.hostname = process.env.DEVELOPMENT_HOST;
  apiaiOptions.path = "/api/query";
}

const apiAiService = apiai(apiAiAccessToken, apiaiOptions);
const sessionIds = new Map();

const controller = Botkit.slackbot({
  debug: false
  //include "log: false" to disable logging
});

var bot = controller.spawn({
  token: slackBotKey
}).startRTM();

function isDefined(obj) {
  if (typeof obj == 'undefined') {
    return false;
  }
  if (!obj) {
    return false;
  }
  return obj != null;
}

const TimeOutError = 'I couldn\'t resolve your request';
const TimeoutDuration = 90000;
const timeoutAfter = duration => new Promise((_, reject) => setTimeout(() => reject(TimeOutError), duration));

function firstReady(...promises) {
  let completed = false;
  const complete = f => result => {
    if (!completed) {
      completed = true;
      f(result);
    }
  };
  return new Promise((resolve, reject) => promises.forEach(p => p.then(complete(resolve), complete(reject))));
}

controller.hears(['.*'], ['direct_message', 'direct_mention', 'mention', 'ambient'], (bot, message) => {
  try {
    if (message.type == 'message') {
      if (message.user == bot.identity.id) {
         // message from bot can be skipped
      } else if (message.text.indexOf("<@U") == 0 && message.text.indexOf(bot.identity.id) == -1) {
          // skip other users direct mentions
      }
      else {
        let requestText = decoder.decode(message.text);
        requestText = requestText.replace("’", "'");
        let channel = message.channel;
        let messageType = message.event;
        let botId = '<@' + bot.identity.id + '>';
        let userId = message.user;

        if (requestText.indexOf(botId) > -1) {
          requestText = requestText.replace(botId, '');
        }
        if (!sessionIds.has(channel)) {
          sessionIds.set(channel, uuid.v1());
        }
        let request = apiAiService.textRequest(requestText,
          {
            sessionId: sessionIds.get(channel),
            contexts: [
                {
                    name: "generic",
                    parameters: {
                        slack_user_id: userId,
                        slack_channel: channel
                    }
                }
            ]
          });
        request.on('response', (response) => {
          if (isDefined(response.result)) {
            let responseText = response.result.fulfillment.speech;
            let responseData = response.result.fulfillment.data;
            let action = response.result.action;
            let parameters = response.result.parameters;
            if (action === 'search') {
              let searchProject = response.result.parameters['searchProject'];
              let searchUser = response.result.parameters['searchUser'];

              // The action variable would be the value that we defined under every intent.
              let action = response.result.action;

              // The parameters variable will show us the value of the entities.
              let parameters = response.result.parameters;
              let text = response.result.parameters['text'][0];
              var search = github.search();
              if (searchProject) {
                console.log(searchProject, text)
                firstReady(
                  search.forRepositories({ q: text, sort: 'stars', order: 'desc', page:1, per_page: 5}),
                  timeoutAfter(TimeoutDuration)).then(r => { 
                    if (r.data) {
                      console.log(r.data);
                      responseText = 'Here are the first 3 result:' + '\n' + r.data[0]['full_name'] + '\n' + r.data[1]['full_name'] + '\n' + r.data[2]['full_name'];
                      bot.reply(message, responseText);
                    } else {
                      responseText = 'Sorry, I can\'t find project related to ' + text + '. Please try one more time';
                      bot.reply(message, responseText); 
                    }
                  })
                  .catch(e => {
                    console.log(e);
                    console.log('Something went wrong');
                    bot.reply(message, e)
                  });
              } else if (searchUser) {
                console.log(text);
                  firstReady(search.forUsers({ q: text}), timeoutAfter(TimeoutDuration)).then(r => {
                      let user = r.data[0]['html_url'];
                      console.log(user);
                      if (user) {
                        let responseText = user;
                        bot.reply(message, responseText);
                      } else {
                          let responseText = 'I can\'t find this user\'s profile, please try again';
                          bot.reply(message, responseText);
                      }         
                  })       
              }
            } else if(action === 'follow') {
              var result = response.result.parameters['text'];
              console.log('result is:',result);
              if(result) {
                  //console.log(result);
                var user = github.getUser(result);
                  //console.log(user);   
                firstReady(user.follow(), timeoutAfter(TimeoutDuration)).then(r => { 
                  if(r) {
                    let responseText = 'You successfuly followed ' + result;
                    bot.reply(message, responseText);
                  } else {
                    responseText = 'There was some problem. Please try again.';
                    bot.reply(message, responseText);
                  }  
                });
              }   
            } else if(action === 'createRepo') {
              var result = response.result.parameters['text'];
              if(result) {
                console.log(result);
                var user = github.getUser();
                firstReady(user.createRepo({name: result}), timeoutAfter(TimeoutDuration)).then(r => {
                  console.log(r);
                  let responseText = "You successfuly created repo " + result;
                  bot.reply(message, responseText);
                });
              }  
            }
            if (isDefined(responseData) && isDefined(responseData.slack)) {
              try {
                bot.reply(message, responseData.slack);
              } catch (err) {
                bot.reply(message, err.message);
              }
            } else if (isDefined(responseText)) {
              bot.reply(message, responseText, (err, resp) => {
                if (err) {
                  console.error(err);
                }
              });
            }
            }
        });
        request.on('error', (error) => console.error(error));
        request.end();
      }
    }
  } catch (err) {
    console.error(err);
  }
});

//Create a server to prevent Heroku kills the bot
const server = http.createServer((req, res) => res.end());
//Lets start our server
server.listen((process.env.PORT || 5000), () => console.log("Server listening"));