import { type ChatGPTAPI } from 'chatgpt'
import pMap from 'p-map'
import winkNLPModel from 'wink-eng-lite-web-model'
import winkNLP from 'wink-nlp'

import * as types from './types'
import { createTweet } from './twitter'

const nlp = winkNLP(winkNLPModel)

/**
 * Converts a ChatGPT response string to an array of tweet-sized strings.
 */
export function getTweetsFromResponse(response: string): string[] {
  const paragraphs = response
    .split('\n')
    .map((p) => p.trim())
    .filter(Boolean)

  // const sentences = paragraphs.map((p) => p.sentences().out())
  let tweetDrafts = []
  const maxTweetLength = 250
  let currentTweet = ''

  for (const paragraph of paragraphs) {
    const doc = nlp.readDoc(paragraph)
    let sentences = doc.sentences().out()
    for (let i = 0; i < sentences.length - 1; ++i) {
      const s0 = sentences[i]
      const s1 = sentences[i + 1]
      if (s0.endsWith('.') && /^(js|ts|jsx|tsx)\b/.test(s1)) {
        sentences[0] = `${s0}${s1}`
        sentences.splice(i + 1, 1)
      }
    }
    // console.log(JSON.stringify(sentences, null, 2))

    for (let sentence of sentences) {
      do {
        if (currentTweet.length > 200) {
          tweetDrafts.push(currentTweet)
          currentTweet = ''
        }

        const tweet = currentTweet ? `${currentTweet}\n\n${sentence}` : sentence

        if (tweet.length > maxTweetLength) {
          const tokens = sentence.split(' ')
          let partialTweet = currentTweet ? `${currentTweet}\n\n` : ''
          let partialNextSentence = ''
          let isNext = false

          for (const token of tokens) {
            const temp = `${partialTweet}${token} `
            if (!isNext && temp.length < maxTweetLength) {
              partialTweet = temp
            } else {
              isNext = true
              partialNextSentence = `${partialNextSentence}${token} `
            }
          }

          if (partialTweet.length > maxTweetLength) {
            console.error(
              'error: unexptected tweet length too long',
              partialTweet
            )
          }

          tweetDrafts.push(partialTweet.trim() + '...')
          currentTweet = ''
          sentence = partialNextSentence
        } else {
          currentTweet = tweet.trim()
          break
        }
      } while (sentence.trim().length)
    }
  }

  if (currentTweet) {
    tweetDrafts.push(currentTweet.trim())
    currentTweet = null
  }

  tweetDrafts = tweetDrafts.map((t) => t.trim()).filter(Boolean)
  console.log(tweetDrafts.length, JSON.stringify(tweetDrafts, null, 2))

  const tweets = tweetDrafts.map((draft, index) => {
    if (tweetDrafts.length > 1) {
      return `${index + 1}/${tweetDrafts.length} ${draft}`
    } else {
      return draft
    }
  })

  return tweets
}

/**
 * Asks ChatGPT for a response to a prompt
 */
export async function getChatGPTResponse(
  prompt: string,
  {
    chatgpt
  }: {
    chatgpt: ChatGPTAPI
  }
): Promise<string> {
  let response: string

  try {
    console.log('chatgpt.sendMessage', prompt)
    response = await chatgpt.sendMessage(
      prompt
      // for debugging slow prompts
      // , { onProgress: (r) => console.log('chatgpt...', r) }
    )
  } catch (err: any) {
    console.error('ChatGPT error', {
      tweet: prompt,
      error: err
    })

    throw new Error(`ChatGPT error: ${err.toString()}`)
  }

  response = stripAtMentions(response)?.trim()
  if (!response) {
    throw new Error(`ChatGPT received an empty response`)
  }

  return response
}

function stripAtMentions(text?: string) {
  return text?.replaceAll(/\b\@([a-zA-Z0-9_]+\b)/g, '$1')
}

/**
 * Tweets each tweet in the response thread serially one after the other.
 */
export async function createTwitterThreadForChatGPTResponse({
  mention,
  tweetTexts,
  twitter
}: {
  mention?: any
  tweetTexts: string[]
  twitter?: types.TwitterClient
}): Promise<types.CreatedTweet[]> {
  let prevTweet = mention

  const tweets = (
    await pMap(
      tweetTexts,
      async (text): Promise<types.CreatedTweet> => {
        try {
          const reply = prevTweet?.id
            ? {
                in_reply_to_tweet_id: prevTweet.id
              }
            : undefined

          // Note: this call is rate-limited on our side
          const res = await createTweet(
            {
              text,
              reply
            },
            twitter
          )

          const tweet = res.data

          if (tweet?.id) {
            prevTweet = tweet

            console.log('tweet response', JSON.stringify(tweet, null, 2))

            return tweet
          } else {
            console.error('unknown error creating tweet', res, { text })
            return null
          }
        } catch (err) {
          console.error('error creating tweet', JSON.stringify(err, null, 2))

          if (err.status === 403) {
            const error = new types.ChatError(
              err.error?.detail || `error creating tweet: 403 forbidden`
            )
            error.isFinal = true
            error.type = 'twitter:duplicate'
            throw error
          } else if (err.status === 400) {
            if (
              /value passed for the token was invalid/i.test(
                err.error?.error_description
              )
            ) {
              const error = new types.ChatError(
                `error creating tweet: invalid auth token`
              )
              error.isFinal = false
              error.type = 'twitter:auth'
              throw error
            }
          } else if (err.status === 429) {
            const error = new types.ChatError(
              `error creating tweet: too many requests`
            )
            error.isFinal = false
            error.type = 'twitter:rate-limit'
            throw error
          }

          if (err.status >= 400 && err.status < 500) {
            const error = new types.ChatError(
              `error creating tweet: ${err.status} ${
                err.error?.description || ''
              }`
            )
            error.type = 'unknown'
            throw error
          }

          throw err
        }
      },
      {
        // This has to be set to 1 because each tweet in the thread replies
        // the to tweet before it
        concurrency: 1
      }
    )
  ).filter(Boolean)

  return tweets
}

export function pick<T extends object>(obj: T, ...keys: string[]) {
  return Object.fromEntries(
    keys.filter((key) => key in obj).map((key) => [key, obj[key]])
  ) as T
}

export function omit<T extends object>(obj: T, ...keys: string[]) {
  return Object.fromEntries<T>(
    Object.entries(obj).filter(([key]) => !keys.includes(key))
  ) as T
}

export function maxTwitterId(tweetIdA?: string, tweetIdB?: string): string {
  if (!tweetIdA && !tweetIdB) {
    return null
  }

  if (!tweetIdA) {
    return tweetIdB
  }

  if (!tweetIdB) {
    return tweetIdA
  }

  if (tweetIdA.length < tweetIdB.length) {
    return tweetIdB
  } else if (tweetIdA.length > tweetIdB.length) {
    return tweetIdA
  }

  if (tweetIdA < tweetIdB) {
    return tweetIdB
  }

  return tweetIdA
}
