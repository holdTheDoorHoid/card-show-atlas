# Setting up the "Add a show" Google Form (owner steps)

This is the no account way for organizers and vendors to add or fix a show. It takes about 15 minutes.
Nothing on the form goes live by itself: every answer lands in a review queue first.

How it fits together: organizers fill in the form, Google puts each answer in a spreadsheet, and the
spreadsheet publishes a copy of only the public columns (never the submitter's email). The daily job
reads that copy. No passwords or keys are needed.

## 1. Make the form

1. Open https://forms.google.com while signed in to the Google account you want to own it.
2. Click **Blank form**. Title: **Add a card show to Card Show Atlas**.
   Description: *Free listing on a map of card shows in the US and Canada. We check every submission
   before it goes on the map. Please only share details the organizer publishes for the show.*
3. Add these questions (the type is in brackets; tick **Required** where it says so):
   1. Show name [Short answer] Required
   2. Date or dates [Short answer] Required. Description: *For a regular show, say how often, for example "second Sunday of every month".*
   3. Opening hours [Short answer]
   4. Venue name and full address [Paragraph] Required
   5. Link to the official page or post [Short answer]
   6. What is sold there? [Checkboxes]: Pokémon, Magic, Yu-Gi-Oh, One Piece, Lorcana, Other trading card games, Sports cards, Comics toys or other collectibles
   7. Entry price [Short answer]
   8. About how many vendor tables? [Short answer]
   9. Vendor info: table prices and sizes, how to apply, deadline [Paragraph]
   10. Is this a fix to a show already on the site? Paste its link [Short answer]
   11. Anything else [Paragraph]
   12. Your email, only if we may ask you a question (never published) [Short answer]
4. Click the **Settings** tab. Under **Responses**, make sure **Collect email addresses** is set to
   **Do not collect**, and **Limit to 1 response** is off (so people do not need to sign in).

## 2. Connect a spreadsheet

1. Click the **Responses** tab, then **Link to Sheets**, then **Create a new spreadsheet**, then **Create**.
2. In the spreadsheet, click the **+** at the bottom left to add a sheet. Rename it **public**.
3. In cell **A1** of the **public** sheet, paste this formula and press Enter (it copies every column
   except the last one, the private email):

   `=QUERY('Form Responses 1'!A:L, "select A,B,C,D,E,F,G,H,I,J,K,L", 1)`

   If Google named the first sheet differently, use that name instead of `Form Responses 1`.

## 3. Publish only the public sheet

1. In the spreadsheet menu: **File**, then **Share**, then **Publish to web**.
2. In the first box choose **public** (not "Entire document"). In the second box choose
   **Comma separated values (.csv)**. Click **Publish**, then **OK**.
3. Copy the link it shows.

## 4. Send me two links

Paste both into the chat with Claude:

1. The published CSV link from step 3.
2. The form's own link: in the form, click **Send**, click the link icon, tick **Shorten URL**, and
   copy it.

I will put the form button on the site and teach the daily job to read new answers into the review
queue.
