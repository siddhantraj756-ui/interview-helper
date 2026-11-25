# How to Run OpenCluely (Beginner's Guide)

Welcome! You don't need to be a programmer to get OpenCluely up and running. Just follow these simple, step-by-step instructions.

## Step 1: Install Node.js
OpenCluely is built on a technology called Node.js. You will need to install it first.
1. Go to the official website: [https://nodejs.org](https://nodejs.org/)
2. Download the version marked **"LTS" (Recommended for Most Users)**.
3. Open the downloaded file and click "Next" through the installer (the default settings are perfect).

## Step 2: Download the Project
1. Go to the project page on GitHub.
2. Click the green **"<> Code"** button.
3. Select **"Download ZIP"**.
4. Once it finishes downloading, right-click the ZIP file and select **"Extract All..."** (or double-click it on Mac) to unzip it into a folder on your computer.

## Step 3: Open your Terminal / Command Prompt
You need to open the command line tool on your computer and navigate to the folder you just unzipped.

**On Windows:**
1. Open the unzipped `OpenCluely` folder.
2. Click inside the address bar at the very top of the window, type `cmd`, and press **Enter**. A black command window will pop up.

**On Mac:**
1. Press `Command + Space`, type `Terminal`, and press **Enter**.
2. Type `cd ` (make sure there is a space after `cd`).
3. Drag the unzipped `OpenCluely` folder from your Finder and drop it directly into the Terminal window, then press **Enter**.

## Step 4: Install Dependencies & Run the App
Now that you're in the right folder, type the following commands one by one.

1. First, tell your computer to download all the necessary pieces for the app to work. Type this and press **Enter**:
   ```bash
   npm install
   ```
   *(Wait a minute or two for this to finish. You'll see a lot of text scrolling by — this is normal!)*

2. Finally, start the application! Type this and press **Enter**:
   ```bash
   npm start
   ```

## You're Done! 🎉
OpenCluely should now pop up on your screen. 

> **Important Setup Note:** 
> When the app opens, you will need to enter your **Gemini API Key** in the settings. This is a special password that lets the AI answer your questions. You can get one for free at [Google AI Studio](https://aistudio.google.com/app/apikey).
