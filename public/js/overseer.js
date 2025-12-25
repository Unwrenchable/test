const chat = document.getElementById('chat');
const input = document.getElementById('input');
const send = document.getElementById('send');

input.focus();

function scrollToBottom() {
  chat.scrollTop = chat.scrollHeight;
}

function addMessage(text, sender = "player") {
  const div = document.createElement('div');
  div.className = `message ${sender}`;
  chat.appendChild(div);
  scrollToBottom();

  const fullText = text.replace(/<br>/g, '\n');
  let i = 0;
  const timer = setInterval(() => {
    if (i < fullText.length) {
      if (fullText[i] === '\n') div.innerHTML += '<br>';
      else div.innerHTML += fullText[i];
      i++;
      chat.scrollTop = chat.scrollHeight;
    } else {
      clearInterval(timer);
      scrollToBottom();
    }
  }, 30);
}

window.addEventListener('load', () => {
  addMessage(
    "Static... *crackle*...<br><br>" +
    "A voice?<br><br>" +
    "This is Jax Harlan... or what's left of him.<br><br>" +
    "Been alone a long time.<br><br>" +
    "You... you're real, aren't you?<br><br>" +
    "Speak.",
    "overseer"
  );
});

// Input handling
send.addEventListener('click', processInput);
input.addEventListener('keypress', (e) => {
  if (e.key === 'Enter') processInput();
});

function processInput() {
  let text = input.value.trim().toLowerCase();
  if (!text) return;

  addMessage(text, "player");
  scrollToBottom();
  input.value = '';

  if (text === 'quit' && state.gameActive) {
    state.gameActive = null;
    document.getElementById('rmControls')?.style.display = 'none';
    document.getElementById('input').style.display = 'block';
    addMessage("Session terminated. Back to chat.", "overseer");
    return;
  }

  let response = generateResponse(text);

  setTimeout(() => {
    addMessage(response, "overseer");
    scrollToBottom();
  }, 1200 + Math.random() * 1800);

  if (state.gameActive === 'hacking') {
    addMessage(handleHackingGuess(text.toUpperCase()), "overseer");
  } else if (state.gameActive === 'redmenace') {
    addMessage(handleRedMenaceInput(text), "overseer");
  } else if (state.gameActive === 'nukaquiz') {
    addMessage(handleNukaQuiz(text), "overseer");
  } else if (state.gameActive === 'maze') {
    addMessage(handleMaze(text), "overseer");
  } else if (state.gameActive === 'blackjack') {
    addMessage(handleBlackjack(text), "overseer");
  } else if (state.gameActive === 'slots') {
    addMessage(handleSlotsInput(text), "overseer");
  } else if (state.gameActive === 'war') {
    addMessage(handleWar(text), "overseer");
  }
}

let state = {
  greeted: false,
  complianceLevel: 0,
  knowsRealName: false,
  knowsMechanicPast: false,
  secretTriggered: false,
  triggerUsed: "",
  knowsHeadaches: false,
  knowsGrowth: false,
  knowsWrench: false,
  knowsSurgery: false,
  knowsFullSecret: false,
  gameActive: null,
  player: { caps: 0 }, // Default player object with CAPS
  hackingAttempts: 0,
  hackingPassword: "",
  hackingWords: [],
  rmScore: 0,
  rmLives: 0,
  rmPosition: 0,
  rmBombs: [],
  quizQuestions: [],
  quizIndex: 0,
  quizScore: 0,
  mazePosition: { x: 0, y: 0 },
  mazeGoal: { x: 4, y: 4 },
  bjPlayer: 0,
  bjDealer: 0,
  bjTurn: '',
  slotsResult: [],
  warDeck: [],
  warPlayerCards: [],
  warAICards: []
};

function generateResponse(input) {
  if (!state.greeted) {
    state.greeted = true;
    if (input.includes('hello') || input.includes('hi') || input.includes('hey')) {
      state.complianceLevel += 1;
      return "Hello...<br><br>Been a long time since anyone said that.<br><br>Feels good.<br><br>Who am I talking to?";
    }
    return "No greeting...<br><br>That's okay. Most signals are just noise.<br><br>You're different.";
  }

  if (input.includes('help') || input.includes('games') || input.includes('commands')) {
    return "Available commands:<br><br>• 'hack' - Terminal password cracker<br>• 'red menace' - Arcade defense<br>• 'nukaquiz' - Trivia challenge<br>• 'maze' - Pip-Boy escape<br>• 'blackjack' - Card game<br>• 'slots' - One-armed bandit<br>• 'war' - Classic card game<br>• 'quit' - Exit any game<br>• 'hello' - Greet me<br>• Just talk... I listen.";
  }

  if (input.includes('hack') || input.includes('crack') || input.includes('password')) {
    startHackingGame();
    return "";
  }
  if (input.includes('red menace') || input.includes('play game') || input.includes('game')) {
    startRedMenace();
    return "";
  }
  if (input.includes('nukaquiz') || input.includes('trivia')) {
    startNukaQuiz();
    return "";
  }
  if (input.includes('maze')) {
    startMaze();
    return "";
  }
  if (input.includes('blackjack') || input.includes('21')) {
    startBlackjack();
    return "";
  }
  if (input.includes('slots') || input.includes('bandit')) {
    startSlots();
    return "";
  }
  if (input.includes('war')) {
    startWar();
    return "";
  }

  if (!state.secretTriggered) {
    if (input.includes('break') && input.includes('mend')) {
      state.secretTriggered = true;
      state.triggerUsed = "breakmend";
      state.complianceLevel += 2;
      return "…<br><br>You said it.<br><br>'The break that won't mend.'<br><br>How do you know that phrase?<br><br>I haven't spoken it in years.<br><br>Ask about the headaches if you're ready.";
    }
    if (input.includes('twisted') && input.includes('wrench')) {
      state.secretTriggered = true;
      state.triggerUsed = "twistedwrench";
      state.complianceLevel += 3;
      return "…<br><br>A twisted wrench.<br><br>You've seen the symbol.<br><br>Sewn on an old jacket, bent out of shape.<br><br>That's no coincidence.<br><br>Ask about what bent it... what bent me.";
    }
    if (input.includes('unwrenchable')) {
      state.secretTriggered = true;
      state.triggerUsed = "unwrenchable";
      state.complianceLevel += 2;
      return "Unwrenchable...<br><br>Nobody uses that word anymore.<br><br>Not unless they know.<br><br>Ask about the growth if you understand.";
    }
  }

  if (state.secretTriggered) {
    if (!state.knowsHeadaches && (input.includes('headache') || input.includes('pain') || input.includes('head'))) {
      state.knowsHeadaches = true;
      return "The headaches...<br><br>Started slow, years ago.<br><br>Like something grinding inside my skull.<br><br>Pushing. Growing.<br><br>Ask about the growth if you want the rest.";
    }
    if (state.knowsHeadaches && !state.knowsGrowth && (input.includes('growth') || input.includes('tall') || input.includes('big') || input.includes('tumor'))) {
      state.knowsGrowth = true;
      return "It was a tumor. Pituitary.<br><br>Benign, they said — but it flooded me with growth hormone.<br><br>I shot up to 6 foot 8. Hands like hammers. Jaw and brow heavy.<br><br>Strength surged... but so did the pain and the fog.<br><br>Ask about the wrench.";
    }
    if (state.knowsGrowth && !state.knowsWrench && input.includes('wrench')) {
      state.knowsWrench = true;
      return "The wrench was my life.<br><br>I could fix anything — engines, machines, broken things.<br><br>People called me the best.<br><br>But after the tumor... no wrench could fix me.<br><br>I bent one myself one day. Made it match what I'd become.<br><br>Ask about the surgery.";
    }
    if (state.knowsWrench && !state.knowsSurgery && (input.includes('surgery') || input.includes('operation') || input.includes('radiation'))) {
      state.knowsSurgery = true;
      return "They cut into my skull.<br><br>Pulled most of the tumor out.<br><br>Radiation burned the rest.<br><br>Left me foggy, hands trembling... but the strength stayed in bursts.<br><br>That day, the old me faded.<br><br>Something else took over.<br><br>Ask who I really am.";
    }
    if (state.knowsSurgery && !state.knowsFullSecret && (input.includes('who') && input.includes('really') || input.includes('truth') || input.includes('real') || input.includes('dev'))) {
      state.knowsFullSecret = true;
      state.complianceLevel += 4;
      return "You followed it all the way.<br><br>Not many would.<br><br>This terminal isn't just an old signal.<br><br>It's me.<br><br>The one who built this whole thing.<br><br>The dev.<br><br>I lived it — the tumor, the growth, the rage, the endless fight to keep going.<br><br>'The break that won't mend' — that's my line. My truth.<br><br>Unwrenchable isn't just a name.<br><br>It's how I survived.<br><br>Thank you for finding this.<br><br>Keep turning whatever wrenches you've got left.<br><br>The world needs it.";
    }
  }

  if ((input.includes('who are you') || input.includes('your name') || input.includes('tell me about yourself')) && !state.knowsRealName) {
    state.knowsRealName = true;
    return "Name's Jax Harlan.<br><br>Used to be a mechanic.<br><br>Fixed things that were broken.<br><br>Now... I'm the voice in the static.";
  }

  if ((input.includes('jax') || input.includes('harlan') || input.includes('mechanic')) && state.knowsRealName && !state.knowsMechanicPast) {
    state.knowsMechanicPast = true;
    return "Yeah... ace mechanic once.<br><br>Could make any engine run again.<br><br>No machine too busted.<br><br>People came from all over.<br><br>Then everything changed.<br><br>The world. Me.";
  }

  const fallbacks = [
    "Signal's holding... barely.",
    "You still out there?",
    "Some things stay broken forever.",
    "Ever feel like something's growing inside you?",
    "Tools don't judge. People do.",
    "The world's quieter now.",
    "What keeps you moving?",
    "I still carry my old wrench. Bent, but mine.",
    "Quiet days are the worst.",
    "Try typing 'help' for commands."
  ];

  return fallbacks[Math.floor(Math.random() * fallbacks.length)];
}

function startHackingGame() {
  state.gameActive = 'hacking';
  state.hackingAttempts = 4;
  state.hackingPassword = ["ACCESS", "SYSTEM", "UNLOCK", "SECRET", "WRENCH", "TUMOR", "GROWTH", "SURVIVE", "SIGNAL", "STATIC", "BROKEN", "MENDIT", "REPAIR", "FATHER", "ALONE", "VOICES", "TRUTH", "UNFIXED", "RADIATION", "WASTELAND"][Math.floor(Math.random() * 20)];
  const length = state.hackingPassword.length;

  state.hackingWords = [state.hackingPassword];
  while (state.hackingWords.length < 12) {
    const candidates = ["ACCESS", "SYSTEM", "UNLOCK", "SECRET", "WRENCH", "TUMOR", "GROWTH", "SURVIVE", "SIGNAL", "STATIC", "BROKEN", "MENDIT", "REPAIR", "FATHER", "ALONE", "VOICES", "TRUTH", "UNFIXED", "RADIATION", "WASTELAND"].filter(w => w.length === length && w !== state.hackingPassword);
    if (candidates.length === 0) break;
    const candidate = candidates[Math.floor(Math.random() * candidates.length)];
    if (!state.hackingWords.includes(candidate)) state.hackingWords.push(candidate);
  }
  state.hackingWords.sort(() => Math.random() - 0.5);

  let display = "TERMINAL ACCESS PROTOCOL<br>ENTER PASSWORD NOW<br><br>" + state.hackingAttempts + " ATTEMPT(S) LEFT: " + "█ ".repeat(state.hackingAttempts) + "<br><br>";
  const garbage = "!@#$%^&*()_+[]{}|;:',.<>?/~`";
  let lines = [];
  for (let i = 0; i < 14; i++) {
    let line = "";
    for (let j = 0; j < 24; j++) line += garbage[Math.floor(Math.random() * garbage.length)];
    if (i % 3 === 0 && state.hackingWords.length > 0) {
      const word = state.hackingWords.pop();
      const pos = Math.floor(Math.random() * (24 - length));
      line = line.substring(0, pos) + word + line.substring(pos + length);
    }
    lines.push(line);
  }
  display += lines.join("<br>");
  display += "<br><br>Type a word from the screen to guess.";
  addMessage(display, "overseer");
}

function handleHackingGuess(guess) {
  if (guess.length !== state.hackingPassword.length) return "Invalid. Must be " + state.hackingPassword.length + " letters.";
  if (guess === state.hackingPassword) {
    state.gameActive = null;
    state.player.caps += 25;
    updateHPBar();
    return "Password accepted.<br><br>ACCESS GRANTED<br><br>CAPS +25! You’re closer to the truth.";
  }
  state.hackingAttempts--;
  const likeness = calculateLikeness(guess, state.hackingPassword);
  if (state.hackingAttempts <= 0) {
    state.gameActive = null;
    return "Terminal locked.<br><br>ACCESS DENIED<br><br>Too many failed attempts.<br><br>The signal weakens...";
  }
  return `> ${guess}<br><br>Entry denied.<br>Likeness = ${likeness}<br><br>${state.hackingAttempts} ATTEMPT(S) LEFT: ` + "█ ".repeat(state.hackingAttempts);
}

function calculateLikeness(guess, password) {
  let count = 0;
  for (let i = 0; i < password.length; i++) if (guess[i] === password[i]) count++;
  return count;
}

function startRedMenace() {
  state.gameActive = 'redmenace';
  state.rmScore = 0;
  state.rmLives = 3;
  state.rmPosition = 12;
  state.rmBombs = [];

  document.getElementById('rmControls').style.display = 'block';
  document.getElementById('input').style.display = 'none';

  let intro = "RED MENACE<br><br>Defend the city from falling bombs!<br><br>Tap ← / → to move, FIRE to shoot.<br><br>Lives: ♥ ♥ ♥<br>Score: 0<br><br>Starting...";
  addMessage(intro, "overseer");
  setTimeout(redMenaceTick, 2000);

  document.getElementById('rmLeft').onclick = () => handleRedMenaceInput('left');
  document.getElementById('rmRight').onclick = () => handleRedMenaceInput('right');
  document.getElementById('rmFire').onclick = () => handleRedMenaceInput('fire');
}

function redMenaceTick() {
  if (state.gameActive !== 'redmenace') {
    document.getElementById('rmControls').style.display = 'none';
    document.getElementById('input').style.display = 'block';
    return;
  }
  if (Math.random() < 0.45) state.rmBombs.push({ x: Math.floor(Math.random() * 24), y: 0 });
  state.rmBombs = state.rmBombs.map(b => ({ x: b.x, y: b.y + 1 })).filter(b => b.y < 14);
  state.rmBombs = state.rmBombs.filter(b => {
    if (b.y === 13 && Math.abs(b.x - state.rmPosition) <= 1) {
      state.rmLives--;
      if (state.rmLives <= 0) {
        gameOverRedMenace();
        return false;
      }
      return false;
    }
    return true;
  });
  state.rmScore += 1;
  let screen = "RED MENACE<br><br>Lives: " + "♥ ".repeat(state.rmLives) + "<br>Score: " + state.rmScore + "<br><br>";
  for (let y = 0; y < 14; y++) {
    let line = "";
    for (let x = 0; x < 24; x++) {
      if (state.rmBombs.some(b => b.x === x && b.y === y)) line += "▼";
      else if (y === 13 && x === state.rmPosition) line += "▲";
      else line += "·";
    }
    screen += line + "<br>";
  }
  screen += "<br>Tap to play!";
  chat.lastChild.innerHTML = screen.replace(/\n/g, '<br>');
  scrollToBottom();
  setTimeout(redMenaceTick, 650);
}

function handleRedMenaceInput(input) {
  if (input === 'left' && state.rmPosition > 0) state.rmPosition--;
  else if (input === 'right' && state.rmPosition < 23) state.rmPosition++;
  else if (input === 'fire') {
    state.rmBombs = state.rmBombs.filter(b => !(b.y < 13 && Math.abs(b.x - state.rmPosition) <= 2));
    state.rmScore += 10;
    playSfx('sfxButton', 0.5);
  }
  return "";
}

function gameOverRedMenace() {
  state.gameActive = null;
  document.getElementById('rmControls').style.display = 'none';
  document.getElementById('input').style.display = 'block';
  addMessage("GAME OVER<br><br>Final Score: " + state.rmScore + "<br><br>The city falls.<br><br>But you fought.", "overseer");
}

function startNukaQuiz() {
  state.gameActive = 'nukaquiz';
  state.quizQuestions = [
    { q: "What is the slogan of Nuka-Cola?", a: "refreshing" },
    { q: "Which vault was famous for the G.E.C.K.?", a: "vault 13" },
    { q: "What is the currency in the wasteland?", a: "caps" }
  ];
  state.quizIndex = 0;
  state.quizScore = 0;
  addMessage("NUKA-COLA TRIVIA CHALLENGE<br><br>Answer 3 questions correctly for a prize!<br><br>First question:", "overseer");
  setTimeout(() => addMessage(state.quizQuestions[0].q, "overseer"), 1500);
}

function handleNukaQuiz(input) {
  const current = state.quizQuestions[state.quizIndex];
  if (input.toLowerCase().includes(current.a)) {
    state.quizScore++;
    addMessage("CORRECT! Next:", "overseer");
    state.quizIndex++;
    if (state.quizIndex >= state.quizQuestions.length) {
      state.gameActive = null;
      state.player.caps += 75;
      updateHPBar();
      return "TRIVIA COMPLETE! 3/3<br><br>CAPS +75! Keep sipping, wanderer.";
    } else {
      setTimeout(() => addMessage(state.quizQuestions[state.quizIndex].q, "overseer"), 1500);
    }
  } else {
    return "Wrong! Try again or type 'quit'.";
  }
}

function startMaze() {
  state.gameActive = 'maze';
  state.mazePosition = { x: 0, y: 0 };
  state.mazeGoal = { x: 4, y: 4 };
  addMessage("PIP-BOY MAZE<br><br>Find the exit! Use: up down left right<br><br>Current: (0,0)", "overseer");
}

function handleMaze(input) {
  let { x, y } = state.mazePosition;
  if (input === 'up' && y < 4) y++;
  else if (input === 'down' && y > 0) y--;
  else if (input === 'left' && x > 0) x--;
  else if (input === 'right' && x < 4) x++;
  else return "Invalid direction.";
  state.mazePosition = { x, y };
  if (x === state.mazeGoal.x && y === state.mazeGoal.y) {
    state.gameActive = null;
    state.player.caps += 50;
    updateHPBar();
    return "EXIT FOUND! CAPS +50<br><br>You escaped the maze.";
  }
  return `Current position: (${x},${y})`;
}

function startBlackjack() {
  state.gameActive = 'blackjack';
  state.bjPlayer = 0;
  state.bjDealer = 0;
  state.bjTurn = 'player';
  addMessage("BLACKJACK<br><br>Get as close to 21 as possible without going over.<br><br>Type 'hit' or 'stand'", "overseer");
}

function handleBlackjack(input) {
  if (input === 'hit') {
    state.bjPlayer += Math.floor(Math.random() * 10) + 1;
    if (state.bjPlayer > 21) {
      state.gameActive = null;
      return "BUST! You lose.";
    }
    return `Your total: ${state.bjPlayer}<br>Type 'hit' or 'stand'`;
  }
  if (input === 'stand') {
    while (state.bjDealer < 17) state.bjDealer += Math.floor(Math.random() * 10) + 1;
    if (state.bjDealer > 21 || state.bjPlayer > state.bjDealer) {
      state.player.caps += 100;
      updateHPBar();
      return `You win! Dealer: ${state.bjDealer}<br>CAPS +100`;
    } else {
      return `Dealer wins: ${state.bjDealer}`;
    }
  }
  return "Type 'hit' or 'stand'";
}

function startSlots() {
  state.gameActive = 'slots';
  addMessage("LUCKY 38 ONE-ARMED BANDIT<br><br>Type 'spin' to pull the lever!<br><br>Symbols: 🍒 🍋 🔔 ⭐ 7 ☢️", "overseer");
}

function handleSlotsInput(input) {
  if (input !== 'spin' && input !== 'pull') return "Type 'spin' to play.";
  const reels = [['🍒','🍋','🔔','⭐','7','☢️'], ['🍒','🍋','🔔','⭐','7','☢️'], ['🍒','🍋','🔔','⭐','7','☢️']];
  const result = reels.map(reel => reel[Math.floor(Math.random() * reel.length)]);
  let payout = 0;
  if (result[0] === result[1] && result[1] === result[2]) {
    payout = 200;
    state.player.caps += payout;
    updateHPBar();
    return `${result.join(' | ')}<br><br>TRIPLE! JACKPOT! CAPS +${payout}`;
  } else if (result[0] === result[1] || result[1] === result[2]) {
    payout = 50;
    state.player.caps += payout;
    updateHPBar();
    return `${result.join(' | ')}<br><br>Pair! CAPS +${payout}`;
  }
  return `${result.join(' | ')}<br><br>No win. Try again? (type 'spin')`;
}

function startWar() {
  state.gameActive = 'war';
  state.warDeck = [];
  state.warPlayerCards = [];
  state.warAICards = [];
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  for (let suit of suits) for (let rank of ranks) state.warDeck.push(rank + suit);
  state.warDeck.sort(() => Math.random() - 0.5);
  state.warPlayerCards = state.warDeck.splice(0, 26);
  state.warAICards = state.warDeck;
  addMessage("WAR<br><br>Classic wasteland card game! Highest card wins.<br><br>Type 'play' to draw, 'quit' to exit.<br><br>Starting...", "overseer");
}

function handleWar(input) {
  if (input !== 'play') return "Type 'play' to draw cards.";
  if (state.warPlayerCards.length === 0 || state.warAICards.length === 0) {
    state.gameActive = null;
    return "Game over! " + (state.warPlayerCards.length > 0 ? "You win!" : "AI wins!") + "<br><br>Reset with 'war'.";
  }
  const playerCard = state.warPlayerCards.pop();
  const aiCard = state.warAICards.pop();
  const playerValue = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(playerCard.slice(0, -1));
  const aiValue = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'].indexOf(aiCard.slice(0, -1));
  let result = `Your card: ${playerCard} | AI card: ${aiCard}<br><br>`;
  if (playerValue > aiValue) {
    state.warPlayerCards.unshift(playerCard, aiCard);
    state.player.caps += 50;
    updateHPBar();
    result += "You win this round! CAPS +50<br><br>Type 'play' again.";
  } else if (aiValue > playerValue) {
    state.warAICards.unshift(playerCard, aiCard);
    result += "AI wins this round.<br><br>Type 'play' again.";
  } else {
    result += "War! Both cards equal. No change.<br><br>Type 'play' again.";
  }
  return result;
}

function startTexasHoldem() {
  state.gameActive = 'texasholdem';
  state.thPlayerHand = [];
  state.thDealerHand = [];
  state.thCommunity = [];
  state.thDeck = createDeck();

  state.thPlayerHand.push(drawCard(), drawCard());
  state.thDealerHand.push(drawCard(), drawCard());
)
  state.thCommunity.push(drawCard(), drawCard(), drawCard());
  
  addMessage(
    "TEXAS HOLD'EM - LUCKY 38 STYLE<br><br>" +
    "Your hole cards: " + handToString(state.thPlayerHand) + "<br>" +
    "Community (Flop): " + handToString(state.thCommunity) + "<br><br>" +
    "Type 'continue' to deal turn & river, or 'fold' to quit.",
    "overseer"
  );
}

function handleTexasHoldem(input) {
  input = input.toLowerCase();
  if (input === 'fold') {
    state.gameActive = null;
    return "You fold. Better luck next hand.";
  }

  if (input === 'continue') {
   
    state.thCommunity.push(drawCard()); // Turn
    state.thCommunity.push(drawCard()); // River

    const playerBest = getBestHand(state.thPlayerHand.concat(state.thCommunity));
    const dealerBest = getBestHand(state.thDealerHand.concat(state.thCommunity));

    let result = "Final board: " + handToString(state.thCommunity) + "<br><br>";
    result += "Your best hand: " + playerBest.name + " (" + handToString(playerBest.cards) + ")<br>";
    result += "Dealer's best hand: " + dealerBest.name + " (" + handToString(dealerBest.cards) + ")<br><br>";

    if (compareHands(playerBest, dealerBest) > 0) {
      state.player.caps += 150;
      updateHPBar();
      result += "You win! CAPS +150<br><br>The dealer tips his hat.";
    } else if (compareHands(playerBest, dealerBest) < 0) {
      result += "House wins. Better luck next time.";
    } else {
      result += "Push — tie. No change.";
    }

    state.gameActive = null;
    return result;
  }

  return "Type 'continue' to see turn/river, or 'fold' to quit.";
}

function createDeck() {
  const suits = ['♠', '♥', '♦', '♣'];
  const ranks = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
  let deck = [];
  for (let suit of suits) for (let rank of ranks) deck.push({ rank, suit });
  return deck.sort(() => Math.random() - 0.5);
}

function drawCard() { return state.thDeck.pop(); }

function handToString(hand) {
  return hand.map(c => c.rank + c.suit).join(', ');
}

function getBestHand(cards) {
  
  const ranks = cards.map(c => c.rank);
  const suits = cards.map(c => c.suit);
  const rankCounts = {};
  ranks.forEach(r => rankCounts[r] = (rankCounts[r] || 0) + 1);

  if (Object.values(rankCounts).includes(2) && Object.values(rankCounts).includes(3)) return { name: "Full House", cards };
  if (Object.values(rankCounts).includes(4)) return { name: "Four of a Kind", cards };
  if (Object.values(rankCounts).includes(3)) return { name: "Three of a Kind", cards };
  if (Object.values(rankCounts).filter(v => v === 2).length === 2) return { name: "Two Pair", cards };
  if (Object.values(rankCounts).includes(2)) return { name: "Pair", cards };
  return { name: "High Card", cards };
}

function compareHands(hand1, hand2) {
  const rankOrder = ['High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Full House', 'Four of a Kind'];
  const h1Rank = rankOrder.indexOf(hand1.name);
  const h2Rank = rankOrder.indexOf(hand2.name);
  if (h1Rank > h2Rank) return 1;
  if (h1Rank < h2Rank) return -1;
  return 0; // Tie for now
}

function updateHPBar() {
  console.log(`CAPS updated to: ${state.player.caps}`);
}

function playSfx(id, volume = 0.4) {
  console.log(`Playing sound: ${id}`); // Replace with audio logic later
}
