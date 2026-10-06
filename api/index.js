const crypto = require("crypto");

const PAYSTACK_URL = "https://api.paystack.co";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY;
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY;

function json(res, status, body) {
  res.status(status).json(body);
}

function requireEnv() {
  if (!SUPABASE_URL || !SUPABASE_SECRET_KEY || !PAYSTACK_SECRET_KEY) {
    throw new Error("Server environment variables are not configured.");
  }
}

async function sb(path, options = {}) {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
      data?.error ||
      "Database request failed."
    );
  }

  return data;
}

function generateAccessCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let value = "";

  for (let i = 0; i < 5; i++) {
    value += chars[crypto.randomInt(chars.length)];
  }

  return `${value.slice(0, 1)}-${value.slice(1)}`;
}

async function createPayment(body, origin) {
  const {
    name,
    email,
    phone,
    amount
  } = body;

  const allowedAmounts = [1000, 2500, 4000];

  if (
    !name ||
    !email ||
    !phone ||
    !allowedAmounts.includes(Number(amount))
  ) {
    throw new Error("Please provide valid registration details.");
  }

  const studentRows = await sb("students", {
    method: "POST",
    headers: {
      "Prefer": "return=representation"
    },
    body: JSON.stringify({
      full_name: name,
      email,
      phone,
      package: String(amount),
      payment_status: "pending"
    })
  });

  const student = studentRows[0];

  const reference =
    `WAEC-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;

  await sb("payments", {
    method: "POST",
    body: JSON.stringify({
      student_id: student.id,
      reference,
      amount: Number(amount) * 100,
      status: "pending"
    })
  });

  const paystack = await fetch(
    `${PAYSTACK_URL}/transaction/initialize`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        email,
        amount: String(Number(amount) * 100),
        currency: "NGN",
        reference,
        callback_url: `${origin}/?payment=callback`,
        metadata: JSON.stringify({
          student_id: student.id
        })
      })
    }
  );

  const result = await paystack.json();

  if (!paystack.ok || !result.status) {
    throw new Error(
      result.message ||
      "Paystack could not initialize the payment."
    );
  }

  return {
    authorization_url: result.data.authorization_url,
    reference
  };
}

async function fulfill(reference, transactionData) {
  const paymentRows = await sb(
    `payments?reference=eq.${encodeURIComponent(reference)}&select=*`
  );

  const payment = paymentRows[0];

  if (!payment) {
    throw new Error("Payment record not found.");
  }

  if (
    transactionData &&
    String(transactionData.status).toLowerCase() !== "success"
  ) {
    throw new Error("Payment is not successful.");
  }

  const studentRows = await sb(
    `students?id=eq.${encodeURIComponent(payment.student_id)}&select=*`
  );

  const student = studentRows[0];

  if (!student) {
    throw new Error("Student record not found.");
  }

  if (
    student.payment_status !== "paid" ||
    !student.access_code
  ) {
    let code = student.access_code;

    if (!code) {
      for (let i = 0; i < 10; i++) {
        const candidate = generateAccessCode();

        const existing = await sb(
          `students?access_code=eq.${encodeURIComponent(candidate)}&select=id`
        );

        if (!existing.length) {
          code = candidate;
          break;
        }
      }

      if (!code) {
        throw new Error(
          "Could not generate a unique access code."
        );
      }
    }

    await sb(
      `students?id=eq.${encodeURIComponent(student.id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          payment_status: "paid",
          access_code: code
        })
      }
    );

    await sb(
      `payments?reference=eq.${encodeURIComponent(reference)}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          status: "success",
          paid_at: new Date().toISOString()
        })
      }
    );

    student.payment_status = "paid";
    student.access_code = code;
  }

  return student;
}

async function verifyPayment(reference) {
  if (!reference) {
    throw new Error("Payment reference is missing.");
  }

  const response = await fetch(
    `${PAYSTACK_URL}/transaction/verify/${encodeURIComponent(reference)}`,
    {
      headers: {
        Authorization: `Bearer ${PAYSTACK_SECRET_KEY}`
      }
    }
  );

  const result = await response.json();

  if (
    !response.ok ||
    !result.status ||
    result.data.status !== "success"
  ) {
    throw new Error(
      "Payment has not been verified as successful."
    );
  }

  const student = await fulfill(
    reference,
    result.data
  );

  return {
    student,
    access_code: student.access_code
  };
}

async function login(body) {
  const code = String(body.code || "")
    .trim()
    .toUpperCase();

  if (!code) {
    throw new Error("Access code is required.");
  }

  const rows = await sb(
    `students?access_code=eq.${encodeURIComponent(code)}&payment_status=eq.paid&select=id,full_name,email,phone,package,payment_status,access_code`
  );

  if (!rows.length) {
    throw new Error("Invalid access code.");
  }

  return {
    student: rows[0]
  };
}

async function subjects() {
  const rows = await sb(
    "subjects?select=id,name&order=name.asc"
  );

  return {
    subjects: rows
  };
}

async function questions(body) {
  const subjectId = String(
    body.subject_id || ""
  );

  if (!/^[0-9a-f-]{36}$/i.test(subjectId)) {
    throw new Error("Invalid subject.");
  }

  const rows = await sb(
    `questions?subject_id=eq.${encodeURIComponent(subjectId)}&select=id,subject_id,question_text,option_a,option_b,option_c,option_d,correct_answer,explanation&order=created_at.asc`
  );

  return {
    questions: rows
  };
}

async function submitResult(body) {
  const {
    student_id,
    subject_id,
    score,
    total_questions
  } = body;

  if (!student_id || !subject_id) {
    throw new Error("Missing result details.");
  }

  await sb("attempts", {
    method: "POST",
    body: JSON.stringify({
      student_id,
      subject_id,
      score: Number(score),
      total_questions: Number(total_questions),
      completed_at: new Date().toISOString()
    })
  });

  return {
    ok: true
  };
}

async function handleWebhook(req, res) {
  const signature =
    req.headers["x-paystack-signature"];

  const raw = JSON.stringify(req.body);

  const expected =
    crypto
      .createHmac("sha512", PAYSTACK_SECRET_KEY)
      .update(raw)
      .digest("hex");

  if (
    !signature ||
    !crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected)
    )
  ) {
    return json(res, 401, {
      error: "Invalid webhook signature."
    });
  }

  if (
    req.body?.event === "charge.success" &&
    req.body?.data?.reference
  ) {
    try {
      await verifyPayment(
        req.body.data.reference
      );
    } catch (err) {
      return json(res, 500, {
        error: err.message
      });
    }
  }

  return json(res, 200, {
    received: true
  });
}

module.exports = async (req, res) => {
  try {
    requireEnv();

    if (
      req.method === "POST" &&
      req.query?.webhook === "1"
    ) {
      return handleWebhook(req, res);
    }

    if (req.method !== "POST") {
      return json(res, 405, {
        error: "Method not allowed."
      });
    }

    const body = req.body || {};
    const action = body.action;

    if (action === "create-payment") {
      const origin =
        `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

      return json(
        res,
        200,
        await createPayment(body, origin)
      );
    }

    if (action === "verify-payment") {
      return json(
        res,
        200,
        await verifyPayment(body.reference)
      );
    }

    if (action === "login") {
      return json(
        res,
        200,
        await login(body)
      );
    }

    if (action === "subjects") {
      return json(
        res,
        200,
        await subjects()
      );
    }

    if (action === "questions") {
      return json(
        res,
        200,
        await questions(body)
      );
    }

    if (action === "submit-result") {
      return json(
        res,
        200,
        await submitResult(body)
      );
    }

    return json(res, 400, {
      error: "Unknown action."
    });

    } catch (err) {
    return json(res, 400, {
      error: err.message || "Request failed."
      } catch (err) {
    return json(res, 400, {
      error: err.message || "Request failed."
    });
  }
};
