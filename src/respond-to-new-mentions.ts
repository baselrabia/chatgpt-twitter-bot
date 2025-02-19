import { ChatGPTAPI } from 'chatgpt'
import delay from 'delay'
import { franc } from 'franc'
import { iso6393 } from 'iso-639-3'
import pMap from 'p-map'
import pTimeout, { TimeoutError } from 'p-timeout'
import urlRegex from 'url-regex'

import * as types from './types'
import config, {
  enableRedis,
  languageAllowList,
  languageDisallowList,
  tweetIgnoreList,
  twitterBotHandle,
  twitterBotHandleL
} from './config'
import { keyv } from './keyv'
import {
  createTwitterThreadForChatGPTResponse,
  getChatGPTResponse,
  getTweetsFromResponse,
  maxTwitterId,
  pick
} from './utils'

/**
 * Fetches new unanswered mentions, resolves them via ChatGPT, and tweets response
 * threads for each one.
 */
export async function respondToNewMentions({
  dryRun,
  earlyExit,
  debugTweet,
  chatgpt,
  twitter,
  user,
  sinceMentionId
}: {
  dryRun: boolean
  earlyExit: boolean
  debugTweet?: string
  chatgpt: ChatGPTAPI
  twitter: types.TwitterClient
  user: types.TwitterUser
  sinceMentionId?: string
}): Promise<types.ChatGPTSession> {
  console.log('fetching mentions since', sinceMentionId || 'forever')

  function updateSinceMentionId(tweetId: string) {
    if (dryRun || !tweetId) {
      return
    }

    sinceMentionId = maxTwitterId(sinceMentionId, tweetId)
  }

  let mentions = []
  let users = {}
  let tweets = {}

  if (debugTweet) {
    const ids = debugTweet.split(',').map((id) => id.trim())
    const res = await twitter.tweets.findTweetsById({
      ids: ids,
      expansions: ['author_id', 'in_reply_to_user_id', 'referenced_tweets.id'],
      'tweet.fields': [
        'created_at',
        'public_metrics',
        'conversation_id',
        'in_reply_to_user_id',
        'referenced_tweets'
      ]
    })

    mentions = mentions.concat(res.data)

    if (res.includes?.users?.length) {
      for (const user of res.includes.users) {
        users[user.id] = user
      }
    }

    if (res.includes?.tweets?.length) {
      for (const tweet of res.includes.tweets) {
        tweets[tweet.id] = tweet
      }
    }
  } else {
    const mentionsQuery = twitter.tweets.usersIdMentions(user.id, {
      expansions: ['author_id', 'in_reply_to_user_id', 'referenced_tweets.id'],
      'tweet.fields': [
        'created_at',
        'public_metrics',
        'conversation_id',
        'in_reply_to_user_id',
        'referenced_tweets'
      ],
      max_results: 100,
      since_id: sinceMentionId
    })

    for await (const page of mentionsQuery) {
      if (page.data?.length) {
        mentions = mentions.concat(page.data)
      }

      if (page.includes?.users?.length) {
        for (const user of page.includes.users) {
          users[user.id] = user
        }
      }

      if (page.includes?.tweets?.length) {
        for (const tweet of page.includes.tweets) {
          tweets[tweet.id] = tweet
        }
      }
    }
  }

  const rUrl = urlRegex()

  function getPrompt(text?: string): string {
    // strip usernames
    let prompt = text
      .replace(twitterBotHandleL, '')
      .replace(twitterBotHandle, '')
      .replace(/^ *@[a-zA-Z0-9_]+/g, '')
      .replace(/^ *@[a-zA-Z0-9_]+/g, '')
      .replace(/^ *@[a-zA-Z0-9_]+/g, '')
      .replace(/^ *@[a-zA-Z0-9_]+/g, '')
      .replace(rUrl, '')
      .trim()

    // fix bug in plaintext version for code blocks
    prompt = prompt.replace('\n\nCopy code\n\n', '\n\n')

    return prompt
  }

  function getNumMentionsInText(
    text?: string,
    { isReply }: { isReply?: boolean } = {}
  ) {
    const prefixText = isReply
      ? (text.match(/^(\@[a-zA-Z0-9_]+,?\s+)+/g) || [])[0]
      : text
    if (!prefixText) {
      return {
        usernames: [],
        numMentions: 0
      }
    }

    const usernames = (prefixText.match(/\@[a-zA-Z0-9_]+\s/g) || []).map(
      (u: string) => u.trim().toLowerCase()
    )
    let numMentions = 0

    for (const username of usernames) {
      if (username === twitterBotHandleL) {
        numMentions++
      }
    }

    return {
      numMentions,
      usernames
    }
  }

  mentions = mentions
    .filter((mention) => {
      if (!mention) {
        return false
      }

      if (tweetIgnoreList.has(mention.id)) {
        return false
      }

      const text = mention.text
      const repliedToTweetRef = mention.referenced_tweets?.find(
        (t) => t.type === 'replied_to'
      )
      const isReply = !!repliedToTweetRef
      const repliedToTweet = repliedToTweetRef
        ? tweets[repliedToTweetRef.id]
        : null
      if (repliedToTweet) {
        repliedToTweet.prompt = getPrompt(repliedToTweet.text)
        const subMentions = getNumMentionsInText(repliedToTweet.text, {
          isReply: !!repliedToTweet.referenced_tweets?.find(
            (t) => t.type === 'replied_to'
          )
        })
        repliedToTweet.numMentions = subMentions.numMentions
      }

      mention.prompt = getPrompt(text)

      if (!mention.prompt) {
        return false
      }

      const { numMentions, usernames } = getNumMentionsInText(text)

      if (
        numMentions > 0 &&
        (usernames[usernames.length - 1] === twitterBotHandleL ||
          (numMentions === 1 && !isReply))
      ) {
        if (isReply && repliedToTweet?.numMentions >= numMentions) {
          console.log('ignoring mention 0', mention, {
            repliedToTweet,
            numMentions
          })

          updateSinceMentionId(mention.id)
          return false
        } else if (numMentions === 1) {
          if (isReply && mention.in_reply_to_user_id === user.id) {
            console.log('ignoring mention 1', mention, {
              numMentions
            })

            updateSinceMentionId(mention.id)
            return false
          }
        }
      } else {
        console.log('ignoring mention 2', pick(mention, 'text', 'id'), {
          numMentions
        })

        updateSinceMentionId(mention.id)
        return false
      }

      console.log(JSON.stringify(mention, null, 2), {
        numMentions,
        repliedToTweet
      })
      // console.log(pick(mention, 'id', 'text', 'prompt'), { numMentions })
      return true
    })
    // only process a max of 5 mentions at a time
    .slice(0, 5)

  console.log(
    `processing ${mentions.length} tweet mentions`,
    mentions.map((mention) => ({
      id: mention.id,
      text: mention.text,
      prompt: mention.prompt
    }))
  )

  const session: types.ChatGPTSession = {
    interactions: [],
    isRateLimited: false,
    isRateLimitedTwitter: false,
    isExpiredAuth: false,
    isExpiredAuthTwitter: false
  }

  if (earlyExit) {
    if (mentions.length > 0) {
      console.log('mentions', JSON.stringify(mentions, null, 2))
    }

    return session
  }

  // TODO: queue chat gpt requests one after another without waiting on twitter?
  // maybe not worth it since rate limiting on ChatGPT's side is a thing...
  const results = (
    await pMap(
      mentions,
      async (mention, index): Promise<types.ChatGPTInteraction> => {
        const { prompt, id: promptTweetId } = mention
        if (session.isRateLimited) {
          return { promptTweetId, prompt, error: 'ChatGPT rate limited' }
        }

        if (session.isRateLimitedTwitter) {
          return { promptTweetId, prompt, error: 'Twitter rate limited' }
        }

        if (session.isExpiredAuth) {
          return { promptTweetId, prompt, error: 'ChatGPT auth expired' }
        }

        if (session.isExpiredAuthTwitter) {
          return { promptTweetId, prompt, error: 'Twitter auth expired' }
        }

        if (!prompt) {
          return {
            promptTweetId,
            prompt,
            error: 'empty prompt',
            isErrorFinal: true
          }
        }

        if (index > 0) {
          // slight slow down between ChatGPT requests
          await delay(1000)
        }

        let response: string
        try {
          // TODO: the `franc` module we're using for language detection doesn't
          // seem very accurate at inferrring english. It will often pick some
          // european dialect instead.
          const lang = franc(prompt, { minLength: 5 })

          if (!languageAllowList.has(lang)) {
            const entry = iso6393.find((i) => i.iso6393 === lang)
            const langName = entry?.name || lang || 'unknown'

            // Check for languages that we know will cause problems for our code
            // and degrace gracefully with an error message.
            if (languageDisallowList.has(lang)) {
              console.error()
              console.error('error: unsupported language detected in prompt', {
                lang,
                langName,
                prompt,
                promptTweetId
              })
              console.error()

              const mentionAuthorUsername = users[mention.author_id]?.username

              const tweets = dryRun
                ? []
                : await createTwitterThreadForChatGPTResponse({
                    mention,
                    twitter,
                    tweetTexts: [
                      `${
                        mentionAuthorUsername
                          ? `Hey @${mentionAuthorUsername}, we're sorry but `
                          : "We're sorry but "
                      }${
                        langName === 'unknown' ? 'your prompt' : langName
                      } is currently not supported by this chatbot. We apologize for the inconvenience and will be adding support for more languages soon.\n\nRef: ${promptTweetId}`
                    ]
                  })

              const responseTweetIds = tweets.map((tweet) => tweet.id)
              return {
                promptTweetId,
                prompt,
                error: `Unsupported language "${langName}"`,
                isErrorFinal: true,
                responseTweetIds
              }
            } else {
              console.warn()
              console.warn(
                'warning: unrecognized language detected in prompt',
                {
                  lang,
                  langName,
                  prompt,
                  promptTweetId
                }
              )
              console.warn()
            }
          }

          const twoMinutesMs = 2 * 60 * 60 * 1000
          response = await pTimeout(getChatGPTResponse(prompt, { chatgpt }), {
            milliseconds: twoMinutesMs,
            message: 'ChatGPT timed out waiting for response'
          })

          const responseL = response.toLowerCase()
          if (responseL.includes('too many requests, please slow down')) {
            session.isRateLimited = true
            return null
          }

          if (
            responseL.includes('your authentication token has expired') ||
            responseL.includes('please try signing in again')
          ) {
            session.isExpiredAuth = true
            return null
          }

          // convert the response to tweet-sized chunks
          const tweetTexts = getTweetsFromResponse(response)

          console.log(
            'prompt',
            `(${promptTweetId})`,
            prompt,
            '=>',
            JSON.stringify(tweetTexts, null, 2)
          )

          const tweets = dryRun
            ? []
            : await createTwitterThreadForChatGPTResponse({
                mention,
                tweetTexts,
                twitter
              })

          const responseTweetIds = tweets.map((tweet) => tweet.id)
          const result = {
            promptTweetId,
            prompt,
            response,
            responseTweetIds
          }

          if (enableRedis && !dryRun) {
            await keyv.set(mention.id, result)
          }

          return result
        } catch (err: any) {
          let isFinal = !!err.isFinal

          if (err instanceof TimeoutError) {
            // TODO: for now, we won't worry about trying to deal with retrying timeouts
            isFinal = true

            // reset chatgpt auth
            session.isExpiredAuth = true

            try {
              if (!dryRun) {
                await createTwitterThreadForChatGPTResponse({
                  mention,
                  twitter,
                  tweetTexts: [
                    `Uh-oh ChatGPT timed out responding to your prompt. Sorry 😓\n\nRef: ${promptTweetId}`
                  ]
                })
              }
            } catch (err2) {
              // ignore
            }
          } else if (err instanceof types.ChatError) {
            if (err.type === 'twitter:auth') {
              // reset twitter auth
              session.isExpiredAuthTwitter = true
            } else if (err.type === 'twitter:rate-limit') {
              session.isRateLimitedTwitter = true
            }
          }

          return {
            promptTweetId,
            prompt,
            response,
            error: err.toString(),
            isErrorFinal: !!isFinal
          }
        }
      },
      {
        concurrency: 1
      }
    )
  ).filter(Boolean)

  for (const res of results) {
    if (!res.error || res.isErrorFinal) {
      updateSinceMentionId(res.promptTweetId)
    }
  }

  session.interactions = results
  session.sinceMentionId = sinceMentionId

  return session
}
